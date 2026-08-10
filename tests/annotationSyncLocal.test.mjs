import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationNoteV8,
} = await import('../src/lib/localAnnotations.ts');
const {
  applyRemoteAnnotationBookDeletionMarkerV5,
  enqueueMissingLocalAnnotationsV5,
  enqueueMissingLocalAnnotationPaletteV5,
  getLocalAnnotationIdsV8,
  getCachedRemoteAnnotationHeadsV5,
  hydrateRemoteAnnotationHeadsV5,
} = await import('../src/lib/annotationSyncLocal.ts');
const {
  getOutboxEventsV5,
  getSyncMetaV5,
  storeRemoteHeadsBatchV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { annotationTargetKeyV1, toAnnotationSyncPayloadV1 } = await import(
  '../src/lib/annotationSyncSchema.ts'
);
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');
const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
const { ANNOTATION_BOOK_DELETE_MARKER_ID } = await import('../src/lib/annotationPolicy.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('hydrate'), 'library:local');
const context = {
  deviceId: 'device-local',
  sessionId: 'session-local',
  createEventId: () => crypto.randomUUID(),
};

const annotation = (id, overrides = {}) => ({
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
  ...overrides,
});

const head = (item, overrides = {}) => ({
  schemaVersion: 1,
  bookId: item.bookId,
  annotationId: item.id,
  revision: 1,
  acceptedEventId: `remote-${item.id}`,
  operation: 'upsert',
  annotation: toAnnotationSyncPayloadV1(item),
  acceptedDeviceId: 'device-remote',
  acceptedSessionId: 'session-remote',
  occurredAtClient: item.updatedAtClient,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});

const bookDeletionHead = (revision) => ({
  schemaVersion: 1,
  bookId: 'book-1',
  annotationId: ANNOTATION_BOOK_DELETE_MARKER_ID,
  revision,
  acceptedEventId: `remote-book-delete-${revision}`,
  operation: 'delete',
  annotation: null,
  acceptedDeviceId: 'device-remote',
  acceptedSessionId: 'session-remote',
  occurredAtClient: revision,
  bookGeneration: revision,
  updatedAtServer: {},
  deletedAtServer: {},
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

test('hydrates remote upserts and tombstones while recording authoritative revisions', async () => {
  const remote = annotation('remote', { note: '원격 메모', updatedAtClient: 3 });
  const applied = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(remote)],
    context.sessionId,
    100,
  );
  assert.equal(applied.changed, true);
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '원격 메모');
  assert.equal((await getSyncMetaV5(
    ownerKey,
    annotationTargetKeyV1('book-1', 'remote'),
  )).knownRevision, 1);
  assert.equal((await getCachedRemoteAnnotationHeadsV5(ownerKey, 'book-1'))[0].operation, 'upsert');

  await hydrateRemoteAnnotationHeadsV5(ownerKey, 'book-1', [head(remote, {
    revision: 2,
    acceptedEventId: 'remote-delete',
    operation: 'delete',
    annotation: null,
    deletedAtServer: {},
  })], context.sessionId, 101);
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1')).length, 0);
  assert.equal((await getCachedRemoteAnnotationHeadsV5(ownerKey, 'book-1'))[0].operation, 'delete');
});

test('does not overwrite a target with pending local work', async () => {
  const local = annotation('shared', { note: '로컬' });
  await saveLocalAnnotationV8(ownerKey, local, context);
  const result = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(annotation('shared', { note: '원격', updatedAtClient: 2 }))],
    context.sessionId,
  );
  assert.equal(result.skipped, 1);
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '로컬');
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
});

test('does not hydrate an upsert older than the current book deletion generation', async () => {
  await storeRemoteHeadsBatchV5(ownerKey, [bookDeletionHead(10)], 50);
  const stale = annotation('stale-generation', { note: '삭제 전 원격' });
  const result = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(stale, { bookGeneration: 9 })],
    context.sessionId,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
});

test('hydrates an upsert at the current book deletion generation', async () => {
  await storeRemoteHeadsBatchV5(ownerKey, [bookDeletionHead(10)], 50);
  const current = annotation('current-generation', { note: '삭제 후 원격' });
  const result = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(current, { bookGeneration: 10 })],
    context.sessionId,
  );
  assert.equal(result.changed, true);
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '삭제 후 원격');
});

test('removes a hydrated stale annotation when only the book deletion marker advances', async () => {
  const stale = annotation('marker-only-stale', { note: '삭제 전 원격' });
  await storeRemoteHeadsBatchV5(ownerKey, [bookDeletionHead(9)], 50);
  await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(stale, { bookGeneration: 9 })],
    context.sessionId,
  );
  assert.deepEqual(
    (await getLocalAnnotationsV8(ownerKey, 'book-1')).map(({ id }) => id),
    [stale.id],
  );

  const result = await applyRemoteAnnotationBookDeletionMarkerV5(
    ownerKey,
    bookDeletionHead(10),
    undefined,
    undefined,
    51,
  );
  assert.deepEqual(result, { changed: true, removed: 1, skipped: 0, stale: false });
  assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
  assert.equal((await getSyncMetaV5(
    ownerKey,
    annotationTargetKeyV1('book-1', ANNOTATION_BOOK_DELETE_MARKER_ID),
  )).knownRevision, 10);
});

test('preserves local work while reconciling an advanced book deletion marker', async () => {
  const pending = annotation('marker-pending', { note: '로컬 작업' });
  await storeRemoteHeadsBatchV5(ownerKey, [
    bookDeletionHead(9),
    head(pending, { bookGeneration: 9 }),
  ], 50);
  await saveLocalAnnotationV8(ownerKey, pending, context);
  const result = await applyRemoteAnnotationBookDeletionMarkerV5(
    ownerKey,
    bookDeletionHead(10),
    undefined,
    undefined,
    51,
  );
  assert.deepEqual(result, { changed: false, removed: 0, skipped: 1, stale: false });
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '로컬 작업');
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
});

test('linearizes a marker advance before a concurrent stale annotation edit', async () => {
  const stale = annotation('marker-race', { note: '삭제 전 원격' });
  await storeRemoteHeadsBatchV5(ownerKey, [bookDeletionHead(9)], 50);
  await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(stale, { bookGeneration: 9 })],
    context.sessionId,
  );

  const markerCommit = applyRemoteAnnotationBookDeletionMarkerV5(
    ownerKey,
    bookDeletionHead(10),
    undefined,
    undefined,
    51,
  );
  const staleEdit = updateLocalAnnotationNoteV8(
    ownerKey,
    'book-1',
    stale.id,
    '부활 시도',
    context,
  );
  const [markerResult, editResult] = await Promise.all([markerCommit, staleEdit]);

  assert.deepEqual(markerResult, { changed: true, removed: 1, skipped: 0, stale: false });
  assert.equal(editResult, null);
  assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
});

test('preserves renderer-local resolution state on an exact session echo', async () => {
  const local = annotation('echo', { anchorState: 'unresolved' });
  await saveLocalAnnotationV8(ownerKey, local);
  await hydrateRemoteAnnotationHeadsV5(ownerKey, 'book-1', [head(local, {
    acceptedSessionId: context.sessionId,
  })], context.sessionId);
  assert.equal(
    (await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].anchorState,
    'unresolved',
  );
});

test('enqueues only local annotations absent from the first authoritative snapshot', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('remote-known'));
  await saveLocalAnnotationV8(ownerKey, annotation('local-only'));
  const events = await enqueueMissingLocalAnnotationsV5(
    ownerKey,
    'book-1',
    new Set(['remote-known']),
    context,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].target.annotationId, 'local-only');
});

test('hydrates an uncached tombstone before deciding whether to bootstrap a local annotation', async () => {
  const local = annotation('deleted-remotely');
  await saveLocalAnnotationV8(ownerKey, local);
  assert.deepEqual(await getLocalAnnotationIdsV8(ownerKey, 'book-1'), [local.id]);
  const tombstone = {
    ...head(local, { revision: 4 }),
    operation: 'delete',
    annotation: null,
    deletedAtServer: {},
  };
  await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [tombstone],
    context.sessionId,
  );
  const events = await enqueueMissingLocalAnnotationsV5(
    ownerKey,
    'book-1',
    new Set(),
    context,
  );
  assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
  assert.deepEqual(events, []);
});

test('does not duplicate a bootstrap event after the app session changes', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('pending'));
  const first = await enqueueMissingLocalAnnotationsV5(
    ownerKey,
    'book-1',
    new Set(),
    { ...context, sessionId: 'session-one', createEventId: () => 'bootstrap-one' },
  );
  const second = await enqueueMissingLocalAnnotationsV5(
    ownerKey,
    'book-1',
    new Set(),
    { ...context, sessionId: 'session-two', createEventId: () => 'bootstrap-two' },
  );
  assert.equal(first.length, 1);
  assert.deepEqual(second, []);
  const events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'bootstrap-one');
});

test('does not duplicate a missing-palette bootstrap after the app session changes', async () => {
  const first = await enqueueMissingLocalAnnotationPaletteV5(
    ownerKey,
    DEFAULT_ANNOTATION_PALETTE,
    { ...context, sessionId: 'palette-one', createEventId: () => 'palette-one' },
  );
  const second = await enqueueMissingLocalAnnotationPaletteV5(
    ownerKey,
    DEFAULT_ANNOTATION_PALETTE,
    { ...context, sessionId: 'palette-two', createEventId: () => 'palette-two' },
  );
  assert.equal(first.event.eventId, 'palette-one');
  assert.equal(second, null);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
});

test('rejects an over-limit remote collection without partially hydrating it', async () => {
  const heads = Array.from({ length: 21 }, (_, index) => {
    const item = annotation(`yellow-${index}`, {
      rangeCfi: `epubcfi(/6/4!/4/2,/1:${index},/1:${index + 1})`,
    });
    return head(item);
  });
  await assert.rejects(
    hydrateRemoteAnnotationHeadsV5(ownerKey, 'book-1', heads, context.sessionId),
    /색상별 제한/,
  );
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1')).length, 0);
  assert.equal(await getSyncMetaV5(
    ownerKey,
    annotationTargetKeyV1('book-1', 'yellow-0'),
  ), undefined);
});

test('aborts hydration and first upload for a stale owner generation', async () => {
  const remote = annotation('stale-remote');
  const hydrated = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    [head(remote)],
    context.sessionId,
    100,
    () => false,
  );
  assert.equal(hydrated.stale, true);
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1')).length, 0);

  await saveLocalAnnotationV8(ownerKey, annotation('stale-local'));
  const events = await enqueueMissingLocalAnnotationsV5(
    ownerKey,
    'book-1',
    new Set(),
    context,
    () => false,
  );
  assert.deepEqual(events, []);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
});

test('aborts an in-flight hydration transaction when the active book is cleaned up', async () => {
  const controller = new AbortController();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function abortAfterAnnotationPut(...args) {
    const request = originalPut.apply(this, args);
    if (this.name === 'annotations-v8') controller.abort();
    return request;
  };
  try {
    const result = await hydrateRemoteAnnotationHeadsV5(
      ownerKey,
      'book-1',
      [head(annotation('aborted-book'))],
      context.sessionId,
      Date.now(),
      () => true,
      controller.signal,
    );
    assert.equal(result.stale, true);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1')).length, 0);
  assert.equal(await getSyncMetaV5(
    ownerKey,
    annotationTargetKeyV1('book-1', 'aborted-book'),
  ), undefined);
});

test('hydrates the full supported 100-annotation book without dropping a color group', async () => {
  const colors = ['yellow', 'green', 'blue', 'pink', 'purple'];
  const heads = Array.from({ length: 100 }, (_, index) => {
    const item = annotation(`full-${index}`, {
      colorId: colors[Math.floor(index / 20)],
      rangeCfi: `epubcfi(/6/4!/4/2,/1:${index * 2},/1:${index * 2 + 1})`,
      updatedAtClient: index + 1,
    });
    return head(item);
  });
  const result = await hydrateRemoteAnnotationHeadsV5(
    ownerKey,
    'book-1',
    heads,
    context.sessionId,
  );
  assert.equal(result.applied, 100);
  const stored = await getLocalAnnotationsV8(ownerKey, 'book-1');
  assert.equal(stored.length, 100);
  assert.deepEqual(
    colors.map((colorId) => stored.filter((item) => item.colorId === colorId).length),
    [20, 20, 20, 20, 20],
  );
});
