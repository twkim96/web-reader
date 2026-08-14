import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const { getAllLocalProgressV5, saveProgressToLocalV5 } = await import('../src/lib/localDBV5.ts');
const { hydrateRemoteBookmarkHeadsV5 } = await import('../src/lib/bookmarkSyncLocal.ts');
const {
  enqueueBookmarkEventV5,
  enqueueProgressMutationBatchV5,
  getOutboxEventsV5,
  getSyncMetaV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { bookmarkTargetKeyV2 } = await import('../src/lib/progressV2Schema.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('bookmark-hydrate'), 'library:local');

const bookmark = (id, overrides = {}) => ({
  id,
  type: 'manual',
  name: `bookmark-${id}`,
  cfi: `epubcfi(/6/4!/4/2/${id.length}:0)`,
  progressPercent: 25,
  createdAt: 10,
  color: '#f59e0b',
  ...overrides,
});

const payload = (item, updatedAtClient = item.createdAt) => ({
  bookmarkId: item.id,
  cfi: item.cfi,
  name: item.name,
  color: item.color,
  progressPercent: item.progressPercent ?? null,
  createdAtClient: item.createdAt,
  updatedAtClient,
});

const head = (item, overrides = {}) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  bookmarkId: item.id,
  revision: 1,
  acceptedEventId: `remote-${item.id}`,
  operation: 'upsert',
  bookmark: payload(item),
  acceptedDeviceId: 'device-remote',
  acceptedSessionId: 'session-remote',
  occurredAtClient: item.createdAt,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

const getProgress = async () => (await getAllLocalProgressV5(ownerKey))
  .find((item) => item.bookId === 'book-1');

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('remote bookmark heads hydrate canonical progress-v5 and preserve local auto bookmarks', async () => {
  const auto = bookmark('auto', { type: 'auto', color: '#64748b' });
  await saveProgressToLocalV5(ownerKey, {
    bookId: 'book-1',
    cfi: 'local-position',
    anchorCfi: 'local-anchor',
    progressPercent: 40,
    lastRead: 50,
    bookmarks: [auto],
  });

  const remote = bookmark('remote', { createdAt: 20 });
  const result = await hydrateRemoteBookmarkHeadsV5(
    ownerKey,
    'book-1',
    [head(remote)],
    'session-local',
    100,
  );

  assert.equal(result.changed, true);
  const stored = await getProgress();
  assert.equal(stored.cfi, 'local-position');
  assert.deepEqual(stored.bookmarks.map(({ id, type }) => ({ id, type })), [
    { id: 'remote', type: 'manual' },
    { id: 'auto', type: 'auto' },
  ]);
  assert.equal((await getSyncMetaV5(
    ownerKey,
    bookmarkTargetKeyV2('book-1', 'remote'),
  )).knownRevision, 1);
});

test('remote bookmark tombstone removes manual bookmark from canonical progress-v5', async () => {
  const local = bookmark('remove-me');
  await saveProgressToLocalV5(ownerKey, {
    bookId: 'book-1',
    cfi: 'position',
    anchorCfi: 'position',
    progressPercent: 10,
    lastRead: 20,
    bookmarks: [local],
  });

  const result = await hydrateRemoteBookmarkHeadsV5(ownerKey, 'book-1', [head(local, {
    revision: 2,
    acceptedEventId: 'remote-delete',
    operation: 'delete',
    bookmark: null,
    deletedAtServer: {},
  })], 'session-local');

  assert.equal(result.changed, true);
  assert.deepEqual((await getProgress()).bookmarks, []);
});

test('pending local bookmark target prevents remote canonical overwrite', async () => {
  const local = bookmark('same', { name: 'local' });
  await enqueueBookmarkEventV5(ownerKey, {
    bookId: 'book-1',
    bookmarkId: local.id,
    operation: 'bookmark.upsert',
    payload: payload(local),
    localBookmarks: [local],
    deviceId: 'device-local',
    sessionId: 'session-local',
    occurredAtClient: 20,
    eventId: 'local-pending',
  });

  const remote = bookmark('same', { name: 'remote' });
  const result = await hydrateRemoteBookmarkHeadsV5(
    ownerKey,
    'book-1',
    [head(remote, { revision: 5 })],
    'session-local',
  );

  assert.equal(result.changed, false);
  assert.equal(result.skipped, 1);
  assert.equal((await getProgress()).bookmarks[0].name, 'local');
  assert.equal((await getSyncMetaV5(
    ownerKey,
    bookmarkTargetKeyV2('book-1', 'same'),
  )).knownRevision, 5);
});

test('bookmark-only mutation persists and enqueues even when reading CFI is empty', async () => {
  const local = bookmark('no-cfi');
  await enqueueProgressMutationBatchV5(ownerKey, {
    progress: {
      bookId: 'book-1',
      cfi: '',
      anchorCfi: '',
      progressPercent: 0,
      lastRead: 0,
      bookmarks: [local],
    },
    progressEvent: null,
    bookmarkEvents: [{
      bookId: 'book-1',
      bookmarkId: local.id,
      operation: 'bookmark.upsert',
      payload: payload(local, 100),
      localBookmarks: [local],
      deviceId: 'device-local',
      sessionId: 'session-local',
      occurredAtClient: 100,
      eventId: 'bookmark-no-cfi',
    }],
  });

  assert.equal((await getProgress()).cfi, '');
  assert.deepEqual((await getProgress()).bookmarks.map(({ id }) => id), ['no-cfi']);
  assert.deepEqual((await getOutboxEventsV5(ownerKey)).map(({ eventId }) => eventId), [
    'bookmark-no-cfi',
  ]);
});
