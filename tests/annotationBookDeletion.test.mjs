import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB, initDB } = await import('../src/lib/localDB.ts');
const {
  LOCAL_DB_NAME,
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} = await import('../src/lib/localDBSchema.ts');
const { removeBookAndAnnotationsV8 } = await import('../src/lib/localDBV5.ts');
const { reconcileAnnotationBookDeletionIntentsV10 } = await import(
  '../src/lib/annotationBookDeletion.ts'
);
const {
  acknowledgeProgressEventV5,
  acquireSyncLeaseV5,
  claimNextProgressEventV5,
  getExpectedClaimV5,
  getOutboxEventsV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { saveLocalAnnotationV8 } = await import('../src/lib/localAnnotations.ts');
const { toAnnotationSyncPayloadV1 } = await import('../src/lib/annotationSyncSchema.ts');
const { makeFirebaseOwnerKey, makeOwnerKey, DEVICE_CONTENT_OWNER_KEY } = await import(
  '../src/lib/ownerIdentity.ts'
);

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('book-delete'), 'library:local');
const context = { deviceId: 'device', sessionId: 'session' };
const annotation = (id, bookId = 'book-1') => ({
  id,
  bookId,
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: `epubcfi(/6/4!/4/2,/1:0,/1:${id.length + 1})`,
  quote: `문장 ${id}`,
  prefix: '',
  suffix: '',
  colorId: 'yellow',
  note: '',
  progressPercent: 10,
  chapter: '1장',
  createdAtClient: 1,
  updatedAtClient: 1,
  anchorState: 'active',
});

test('a newly created highlight explicitly ends the local book-deletion intent', async () => {
  await removeBookAndAnnotationsV8(
    ownerKey,
    DEVICE_CONTENT_OWNER_KEY,
    'book-1',
    context,
  );
  const db = await initDB();
  assert.ok(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']));
  await saveLocalAnnotationV8(ownerKey, annotation('new-highlight'), context);
  assert.equal(
    await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']),
    undefined,
  );
  const events = await getOutboxEventsV5(ownerKey);
  const marker = events.find(({ target }) => (
    target.annotationId === 'book_delete_marker_v1'
  ));
  const highlight = events.find(({ target }) => target.annotationId === 'new-highlight');
  assert.equal(marker.status, 'superseded');
  assert.equal(highlight.status, 'pending');
  assert.equal(highlight.awaitingBookGeneration, undefined);
});

test('waits for an in-flight deletion marker and claims the new highlight at its revision', async () => {
  await removeBookAndAnnotationsV8(
    ownerKey,
    DEVICE_CONTENT_OWNER_KEY,
    'book-1',
    context,
  );
  const now = Date.now() + 1_000;
  const lease = await acquireSyncLeaseV5(ownerKey, 'tab-1', now, 5_000);
  const marker = await claimNextProgressEventV5(
    ownerKey,
    'tab-1',
    lease.epoch,
    now + 1,
    () => 'marker-claim',
  );
  assert.equal(marker.target.annotationId, 'book_delete_marker_v1');

  await saveLocalAnnotationV8(ownerKey, annotation('after-in-flight'), context);
  const queued = (await getOutboxEventsV5(ownerKey)).find(({ target }) => (
    target.annotationId === 'after-in-flight'
  ));
  assert.equal(queued.awaitingBookGeneration, true);
  assert.equal(await claimNextProgressEventV5(
    ownerKey,
    'tab-1',
    lease.epoch,
    now + 2,
  ), null);

  const expectedClaim = getExpectedClaimV5(marker);
  assert.ok(expectedClaim);
  await acknowledgeProgressEventV5(ownerKey, marker.eventId, {
    schemaVersion: 1,
    bookId: 'book-1',
    annotationId: 'book_delete_marker_v1',
    revision: 1,
    acceptedEventId: marker.eventId,
    operation: 'delete',
    annotation: null,
    acceptedDeviceId: context.deviceId,
    acceptedSessionId: context.sessionId,
    occurredAtClient: marker.occurredAtClient,
    bookGeneration: 1,
    updatedAtServer: {},
    deletedAtServer: {},
  }, expectedClaim, now + 3);
  const highlight = await claimNextProgressEventV5(
    ownerKey,
    'tab-1',
    lease.epoch,
    now + 4,
    () => 'highlight-claim',
  );
  assert.equal(highlight.target.annotationId, 'after-in-flight');
  assert.equal(highlight.bookGeneration, 1);
  assert.equal(highlight.awaitingBookGeneration, false);
});

test('releases a generation waiter at generation zero when a marker is resolved as remote-missing', async () => {
  await removeBookAndAnnotationsV8(
    ownerKey,
    DEVICE_CONTENT_OWNER_KEY,
    'book-1',
    context,
  );
  const now = Date.now() + 1_000;
  const lease = await acquireSyncLeaseV5(ownerKey, 'tab-1', now, 5_000);
  const marker = await claimNextProgressEventV5(
    ownerKey,
    'tab-1',
    lease.epoch,
    now + 1,
    () => 'marker-claim',
  );
  await saveLocalAnnotationV8(ownerKey, annotation('after-remote-missing'), context);
  const db = await initDB();
  await db.put(V5_OUTBOX_STORE, {
    ...marker,
    status: 'superseded',
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  });
  const highlight = await claimNextProgressEventV5(
    ownerKey,
    'tab-1',
    lease.epoch,
    now + 2,
    () => 'highlight-claim',
  );
  assert.equal(highlight.target.annotationId, 'after-remote-missing');
  assert.equal(highlight.bookGeneration, 0);
  assert.equal(highlight.awaitingBookGeneration, false);
});
const head = (id, revision, bookId = 'book-1') => ({
  schemaVersion: 1,
  bookId,
  annotationId: id,
  revision,
  acceptedEventId: `remote-${id}`,
  operation: 'upsert',
  annotation: toAnnotationSyncPayloadV1(annotation(id, bookId)),
  acceptedDeviceId: 'remote-device',
  acceptedSessionId: 'remote-session',
  occurredAtClient: 1,
  updatedAtServer: {},
  deletedAtServer: null,
});

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

test('reconciles remote-only and later-created annotations with forced latest-revision tombstones', async () => {
  await removeBookAndAnnotationsV8(
    ownerKey,
    DEVICE_CONTENT_OWNER_KEY,
    'book-1',
    context,
  );
  await reconcileAnnotationBookDeletionIntentsV10(
    'book-delete',
    ownerKey,
    context,
    10_000,
    async () => [head('remote-only', 3)],
  );
  await reconcileAnnotationBookDeletionIntentsV10(
    'book-delete',
    ownerKey,
    context,
    16_000,
    async () => [head('remote-only', 3), head('late-upload', 2)],
  );
  const events = (await getOutboxEventsV5(ownerKey)).filter(({ target }) => (
    target.annotationId !== 'book_delete_marker_v1'
  ));
  assert.deepEqual(events.map(({ target, baseRevision, forceDelete }) => ({
    id: target.annotationId,
    baseRevision,
    forceDelete,
  })).sort((left, right) => left.id.localeCompare(right.id)), [
    { id: 'late-upload', baseRevision: 2, forceDelete: true },
    { id: 'remote-only', baseRevision: 3, forceDelete: true },
  ]);

  const db = await initDB();
  const intent = await db.get(
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    [ownerKey, 'book-1'],
  );
  const markerEvent = (await getOutboxEventsV5(ownerKey)).find(({ target }) => (
    target.annotationId === 'book_delete_marker_v1'
  ));
  await db.delete(V5_OUTBOX_STORE, [ownerKey, markerEvent.eventId]);
  await db.put(V5_REMOTE_HEADS_STORE, {
    ownerKey,
    targetKey: markerEvent.targetKey,
    revision: 1,
    head: {
      schemaVersion: 1,
      bookId: 'book-1',
      annotationId: 'book_delete_marker_v1',
      revision: 1,
      acceptedEventId: markerEvent.eventId,
      operation: 'delete',
      annotation: null,
      acceptedDeviceId: context.deviceId,
      acceptedSessionId: context.sessionId,
      occurredAtClient: intent.createdAt,
      updatedAtServer: {},
      deletedAtServer: {},
    },
    updatedAt: 20_000,
  });
  await reconcileAnnotationBookDeletionIntentsV10(
    'book-delete',
    ownerKey,
    context,
    22_000,
    async () => [],
  );
  assert.equal(
    await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']),
    undefined,
  );
});

test('continues with later book deletion intents when one book fails', async () => {
  const isolatedOwner = makeOwnerKey(
    makeFirebaseOwnerKey('book-delete-isolation'),
    'library:local',
  );
  await removeBookAndAnnotationsV8(
    isolatedOwner,
    DEVICE_CONTENT_OWNER_KEY,
    'book-a',
    context,
  );
  await removeBookAndAnnotationsV8(
    isolatedOwner,
    DEVICE_CONTENT_OWNER_KEY,
    'book-b',
    context,
  );
  const called = [];
  const result = await reconcileAnnotationBookDeletionIntentsV10(
    'book-delete-isolation',
    isolatedOwner,
    context,
    40_000,
    async (_uid, bookId) => {
      called.push(bookId);
      if (bookId === 'book-a') {
        throw Object.assign(new Error('invalid aggregate'), { code: 'invalid-argument' });
      }
      return [head('remote-b', 2, 'book-b')];
    },
  );
  assert.deepEqual(called.sort(), ['book-a', 'book-b']);
  assert.equal(result.failed, 1);
  assert.equal(result.queued, 1);
  const db = await initDB();
  const failedIntent = await db.get(
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    [isolatedOwner, 'book-a'],
  );
  assert.equal(failedIntent.failureCount, 1);
  assert.equal(failedIntent.lastErrorCode, 'invalid-argument');
  assert.ok(failedIntent.nextRetryAt > 40_000);
  assert.ok((await getOutboxEventsV5(isolatedOwner)).some(({ target }) => (
    target.bookId === 'book-b' && target.annotationId === 'remote-b'
  )));
});
