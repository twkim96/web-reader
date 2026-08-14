import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  enqueueProgressMutationBatchV5,
  getOutboxEventsV5,
  getSyncMetaV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('bookmark-batch'), 'library:local');
const local = {
  id: 'coalesce',
  type: 'manual',
  name: 'bookmark',
  cfi: 'bookmark-cfi',
  progressPercent: 10,
  createdAt: 1,
  color: '#fff',
};
const baseProgress = {
  bookId: 'book-1',
  cfi: '',
  anchorCfi: '',
  progressPercent: 0,
  lastRead: 0,
};

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('bookmark-only batches coalesce same-session unclaimed intent', async () => {
  await enqueueProgressMutationBatchV5(ownerKey, {
    progress: { ...baseProgress, bookmarks: [local] },
    progressEvent: null,
    bookmarkEvents: [{
      bookId: 'book-1',
      bookmarkId: local.id,
      operation: 'bookmark.upsert',
      payload: {
        bookmarkId: local.id,
        cfi: local.cfi,
        name: local.name,
        color: local.color,
        progressPercent: local.progressPercent,
        createdAtClient: local.createdAt,
        updatedAtClient: 100,
      },
      localBookmarks: [local],
      deviceId: 'device-local',
      sessionId: 'session-local',
      occurredAtClient: 100,
      eventId: 'bookmark-first',
    }],
  });

  await enqueueProgressMutationBatchV5(ownerKey, {
    progress: { ...baseProgress, bookmarks: [] },
    progressEvent: null,
    bookmarkEvents: [{
      bookId: 'book-1',
      bookmarkId: local.id,
      operation: 'bookmark.delete',
      payload: null,
      localBookmarks: [],
      deviceId: 'device-local',
      sessionId: 'session-local',
      occurredAtClient: 101,
      eventId: 'bookmark-ignored',
    }],
  });

  const events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'bookmark-first');
  assert.equal(events[0].operation, 'bookmark.delete');
  assert.equal(events[0].payload, null);
  assert.equal((await getSyncMetaV5(ownerKey, 'bookmark:book-1:coalesce')).nextSequence, 2);
});
