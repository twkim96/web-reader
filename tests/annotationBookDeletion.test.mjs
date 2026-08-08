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
const { getOutboxEventsV5 } = await import('../src/lib/syncOutboxV5.ts');
const { saveLocalAnnotationV8 } = await import('../src/lib/localAnnotations.ts');
const { toAnnotationSyncPayloadV1 } = await import('../src/lib/annotationSyncSchema.ts');
const { makeFirebaseOwnerKey, makeOwnerKey, DEVICE_CONTENT_OWNER_KEY } = await import(
  '../src/lib/ownerIdentity.ts'
);

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('book-delete'), 'library:local');
const context = { deviceId: 'device', sessionId: 'session' };
const annotation = (id) => ({
  id,
  bookId: 'book-1',
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
});
const head = (id, revision) => ({
  schemaVersion: 1,
  bookId: 'book-1',
  annotationId: id,
  revision,
  acceptedEventId: `remote-${id}`,
  operation: 'upsert',
  annotation: toAnnotationSyncPayloadV1(annotation(id)),
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
