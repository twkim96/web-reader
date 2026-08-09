import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const storageValues = new Map();
globalThis.BroadcastChannel = undefined;
globalThis.window = {
  localStorage: {
    getItem: (key) => storageValues.get(key) ?? null,
    setItem: (key, value) => storageValues.set(key, String(value)),
    removeItem: (key) => storageValues.delete(key),
    clear: () => storageValues.clear(),
  },
  dispatchEvent: () => true,
};

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationNoteV8,
} = await import('../src/lib/localAnnotations.ts');
const { saveLocalAnnotationPaletteV9 } = await import('../src/lib/localAnnotationPalette.ts');
const {
  getOpenAnnotationSyncConflictsV5,
  resolveAnnotationSyncConflictKeepLocalV5,
  resolveAnnotationSyncConflictUseRemoteV5,
} = await import('../src/lib/annotationSyncConflict.ts');
const {
  enqueueAnnotationPaletteEventV5,
  getOutboxEventsV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { toAnnotationSyncPayloadV1 } = await import('../src/lib/annotationSyncSchema.ts');
const {
  DEFAULT_ANNOTATION_PALETTE,
  getStoredAnnotationPalette,
} = await import('../src/lib/annotationPalette.ts');
const { ProgressSyncWorker } = await import('../src/lib/progressSyncWorker.ts');
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('annotation-conflict'), 'library:local');
let eventIndex = 0;
const context = () => ({
  deviceId: 'device-local',
  sessionId: 'session-local',
  createEventId: () => `event-${++eventIndex}`,
});

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

const annotationHead = (item, revision = 2) => ({
  schemaVersion: 1,
  bookId: item.bookId,
  annotationId: item.id,
  revision,
  acceptedEventId: `remote-${item.id}`,
  operation: 'upsert',
  annotation: toAnnotationSyncPayloadV1(item),
  acceptedDeviceId: 'device-remote',
  acceptedSessionId: 'session-remote',
  occurredAtClient: item.updatedAtClient,
  updatedAtServer: {},
  deletedAtServer: null,
});

const resetDatabase = async () => {
  eventIndex = 0;
  ownerRuntime.clear();
  window.localStorage.clear();
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

const createConflict = async (remoteHead, extraResult = {}) => {
  const owner = ownerRuntime.activate(ownerKey);
  const worker = new ProgressSyncWorker(owner, 'tab-1', async () => ({
    status: 'conflict',
    remoteHead,
    ...extraResult,
  }));
  assert.equal(await worker.flushOne(), 'conflict');
  await worker.dispose();
  return (await getOpenAnnotationSyncConflictsV5(ownerKey))[0];
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('uses a validated remote annotation and supersedes the conflicting event', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('shared', { note: '로컬' }), context());
  const conflict = await createConflict(annotationHead(annotation('shared', {
    note: '원격',
    updatedAtClient: 2,
  })));
  const result = await resolveAnnotationSyncConflictUseRemoteV5(
    ownerKey,
    conflict.conflictId,
    100,
  );
  assert.deepEqual(result, { kind: 'annotation', bookId: 'book-1' });
  assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '원격');
  assert.equal((await getOutboxEventsV5(ownerKey))[0].status, 'superseded');
  assert.equal((await getOpenAnnotationSyncConflictsV5(ownerKey)).length, 0);
});

test('keeps the latest local annotation with the authoritative remote revision', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('shared', { note: '로컬' }), context());
  const conflict = await createConflict(annotationHead(annotation('shared', {
    note: '원격',
    updatedAtClient: 2,
  }), 7));
  const replacement = await resolveAnnotationSyncConflictKeepLocalV5(
    ownerKey,
    conflict.conflictId,
    100,
  );
  assert.equal(replacement.target.kind, 'annotation');
  assert.equal(replacement.payload.note, '로컬');
  assert.equal(replacement.baseRevision, 7);
  assert.equal(replacement.status, 'pending');
  const events = await getOutboxEventsV5(ownerKey);
  assert.deepEqual(events.map(({ status }) => status).sort(), ['pending', 'superseded']);
});

test('keeps the canonical annotation written before a prior event conflicts', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('shared', { note: '이전 메모' }), context());
  await updateLocalAnnotationNoteV8(
    ownerKey,
    'book-1',
    'shared',
    '최신 메모',
    { ...context(), sessionId: 'session-later' },
  );
  const conflict = await createConflict(annotationHead(annotation('shared', {
    note: '원격 메모',
    updatedAtClient: 2,
  }), 7));
  const replacement = await resolveAnnotationSyncConflictKeepLocalV5(
    ownerKey,
    conflict.conflictId,
    100,
  );
  assert.equal(replacement.payload.note, '최신 메모');
  assert.equal(replacement.baseRevision, 7);
});

test('uses the authoritative remote book generation when keeping a local annotation', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('generation'), context());
  const conflict = await createConflict(annotationHead(annotation('generation', {
    note: '원격',
    updatedAtClient: 2,
  }), 7), { remoteBookGeneration: 9 });
  const replacement = await resolveAnnotationSyncConflictKeepLocalV5(
    ownerKey,
    conflict.conflictId,
    100,
  );
  assert.equal(replacement.bookGeneration, 9);
});

test('treats an explicitly missing remote annotation as a remote deletion', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('missing'), context());
  const conflict = await createConflict(null);
  await resolveAnnotationSyncConflictUseRemoteV5(ownerKey, conflict.conflictId);
  assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
  assert.equal((await getOutboxEventsV5(ownerKey))[0].status, 'superseded');
});

test('rolls back remote conflict resolution when the remote aggregate is invalid', async () => {
  const duplicateRange = 'epubcfi(/6/4!/4/2,/1:0,/1:20)';
  await saveLocalAnnotationV8(ownerKey, annotation('other', {
    rangeCfi: duplicateRange,
  }));
  await saveLocalAnnotationV8(ownerKey, annotation('shared', { note: '로컬' }), context());
  const conflict = await createConflict(annotationHead(annotation('shared', {
    rangeCfi: duplicateRange,
    note: '원격',
    updatedAtClient: 2,
  })));
  await assert.rejects(
    resolveAnnotationSyncConflictUseRemoteV5(ownerKey, conflict.conflictId),
    /중복 범위/,
  );
  const stored = await getLocalAnnotationsV8(ownerKey, 'book-1');
  assert.equal(stored.find(({ id }) => id === 'shared').note, '로컬');
  assert.equal((await getOutboxEventsV5(ownerKey))[0].status, 'conflict');
  assert.equal((await getOpenAnnotationSyncConflictsV5(ownerKey)).length, 1);
});

test('applies a remote palette conflict without enqueueing a new local event', async () => {
  const local = { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) };
  await enqueueAnnotationPaletteEventV5(ownerKey, { payload: local }, context());
  const remote = {
    items: local.items.map((item) => item.id === 'yellow'
      ? { ...item, meaning: '원격 의미' }
      : item),
  };
  const conflict = await createConflict({
    schemaVersion: 1,
    revision: 3,
    acceptedEventId: 'remote-palette',
    operation: 'set',
    palette: remote,
    acceptedDeviceId: 'device-remote',
    acceptedSessionId: 'session-remote',
    occurredAtClient: 2,
    updatedAtServer: {},
  });
  const result = await resolveAnnotationSyncConflictUseRemoteV5(
    ownerKey,
    conflict.conflictId,
  );
  assert.equal(result.kind, 'palette');
  assert.equal(getStoredAnnotationPalette(ownerKey)[0].meaning, '원격 의미');
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
  assert.equal((await getOutboxEventsV5(ownerKey))[0].status, 'superseded');
});

test('keeps the canonical palette written before a prior event conflicts', async () => {
  const first = DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item }));
  const latest = first.map((item) => item.id === 'yellow'
    ? { ...item, meaning: '최신 의미' }
    : item);
  await saveLocalAnnotationPaletteV9(ownerKey, first, context(), 1);
  await saveLocalAnnotationPaletteV9(
    ownerKey,
    latest,
    { ...context(), sessionId: 'session-later' },
    2,
  );
  const conflict = await createConflict({
    schemaVersion: 1,
    revision: 3,
    acceptedEventId: 'remote-palette',
    operation: 'set',
    palette: { items: first },
    acceptedDeviceId: 'device-remote',
    acceptedSessionId: 'session-remote',
    occurredAtClient: 3,
    updatedAtServer: {},
  });
  const replacement = await resolveAnnotationSyncConflictKeepLocalV5(
    ownerKey,
    conflict.conflictId,
    100,
  );
  assert.equal(
    replacement.payload.items.find(({ id }) => id === 'yellow').meaning,
    '최신 의미',
  );
});
