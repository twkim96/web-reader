import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB, initDB } = await import('../src/lib/localDB.ts');
const {
  LOCAL_DB_NAME,
  V5_REMOTE_HEADS_STORE,
} = await import('../src/lib/localDBSchema.ts');
const {
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationColorsV8,
  updateLocalAnnotationNoteV8,
  deleteLocalAnnotationV8,
} = await import('../src/lib/localAnnotations.ts');
const {
  enqueueAnnotationPaletteEventV5,
  getOutboxEventsV5,
  getSyncMetaV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
const { ProgressSyncWorker } = await import('../src/lib/progressSyncWorker.ts');
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('annotation-sync'), 'library:local');
let nextEvent = 0;
const syncContext = () => ({
  deviceId: 'device-1',
  sessionId: 'session-1',
  createEventId: () => `annotation-event-${++nextEvent}`,
});

const annotation = (id, colorId = 'yellow') => ({
  id,
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: `epubcfi(/6/4!/4/2,/1:0,/1:${id.length + 1})`,
  quote: `문장 ${id}`,
  prefix: '',
  suffix: '',
  colorId,
  note: '',
  progressPercent: 10,
  chapter: '1장',
  createdAtClient: 1,
  updatedAtClient: 1,
  anchorState: 'active',
});

const resetDatabase = async () => {
  nextEvent = 0;
  ownerRuntime.clear();
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('commits a local annotation and its outbox event atomically', async () => {
  const saved = await saveLocalAnnotationV8(ownerKey, annotation('first'), syncContext());
  assert.equal(saved.status, 'saved');
  const events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].target.kind, 'annotation');
  assert.equal(events[0].operation, 'annotation.upsert');
  assert.equal(events[0].payload.anchorState, undefined);
  assert.equal(events[0].baseRevision, 0);
  assert.equal(events[0].bookGeneration, 0);
});

test('captures the committed book deletion marker revision when enqueueing an upsert', async () => {
  const db = await initDB();
  await db.put(V5_REMOTE_HEADS_STORE, {
    ownerKey,
    targetKey: 'annotation:book-1:book_delete_marker_v1',
    revision: 3,
    head: {
      schemaVersion: 1,
      bookId: 'book-1',
      annotationId: 'book_delete_marker_v1',
      revision: 3,
      acceptedEventId: 'marker-event',
      operation: 'delete',
      annotation: null,
      acceptedDeviceId: 'remote-device',
      acceptedSessionId: 'remote-session',
      occurredAtClient: 1,
      bookGeneration: 3,
      updatedAtServer: {},
      deletedAtServer: {},
    },
    updatedAt: 1,
  });
  await saveLocalAnnotationV8(ownerKey, annotation('after-marker'), syncContext());
  const [event] = await getOutboxEventsV5(ownerKey);
  assert.equal(event.bookGeneration, 3);
});

test('broadcasts a committed local annotation mutation to other readers', async () => {
  const originalWindow = globalThis.window;
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const fakeWindow = new EventTarget();
  const posted = [];
  class FakeBroadcastChannel extends EventTarget {
    constructor(name) {
      super();
      this.name = name;
    }

    postMessage(change) {
      if (this.name === 'twreader-annotation-sync-v1') posted.push(change);
    }
  }
  globalThis.window = fakeWindow;
  globalThis.BroadcastChannel = FakeBroadcastChannel;
  try {
    await saveLocalAnnotationV8(ownerKey, annotation('broadcast'), syncContext());
    assert.deepEqual(posted, [{ ownerKey, bookId: 'book-1' }]);
  } finally {
    globalThis.window = originalWindow;
    globalThis.BroadcastChannel = originalBroadcastChannel;
  }
});

test('coalesces unclaimed same-session annotation edits through delete', async () => {
  const context = syncContext();
  await saveLocalAnnotationV8(ownerKey, annotation('first'), context);
  await updateLocalAnnotationNoteV8(ownerKey, 'book-1', 'first', '최신 메모', context);
  let events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.note, '최신 메모');
  await deleteLocalAnnotationV8(ownerKey, 'book-1', 'first', context);
  events = await getOutboxEventsV5(ownerKey);
  assert.equal(events.length, 1);
  assert.equal(events[0].operation, 'annotation.delete');
  assert.equal(events[0].payload, null);
});

test('rolls back a batch mutation when any outbox event cannot be stored', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('first'));
  await saveLocalAnnotationV8(ownerKey, annotation('second'));
  const duplicateIds = {
    deviceId: 'device-1',
    sessionId: 'session-1',
    createEventId: () => 'duplicate-event',
  };
  await assert.rejects(updateLocalAnnotationColorsV8(
    ownerKey,
    'book-1',
    ['first', 'second'],
    'green',
    duplicateIds,
  ));
  const stored = await getLocalAnnotationsV8(ownerKey, 'book-1');
  assert.deepEqual(stored.map(({ colorId }) => colorId), ['yellow', 'yellow']);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
});

test('rejects a sync-incompatible annotation before local or outbox commit', async () => {
  const invalid = {
    ...annotation('too-long-book'),
    bookId: 'b'.repeat(600),
  };
  await assert.rejects(
    saveLocalAnnotationV8(ownerKey, invalid, syncContext()),
    /Invalid local annotation/,
  );
  assert.equal((await getLocalAnnotationsV8(ownerKey, invalid.bookId)).length, 0);
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);

});

test('keeps guest-style local writes out of the sync queue', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('local-only'));
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
});

test('coalesces palette edits and shares the existing lease worker', async () => {
  const context = syncContext();
  const first = { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) };
  const second = {
    items: first.items.map((item) => item.id === 'yellow'
      ? { ...item, meaning: '가장 중요' }
      : item),
  };
  await enqueueAnnotationPaletteEventV5(ownerKey, { payload: first }, context);
  await enqueueAnnotationPaletteEventV5(ownerKey, { payload: second }, context);
  const queued = await getOutboxEventsV5(ownerKey);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].target.kind, 'palette');
  assert.equal(queued[0].payload.items[0].meaning, '가장 중요');

  const clock = Date.now();
  const owner = ownerRuntime.activate(ownerKey);
  const worker = new ProgressSyncWorker(owner, 'tab-1', async (event) => ({
    status: 'apply',
    head: {
      schemaVersion: 1,
      revision: 1,
      acceptedEventId: event.eventId,
      operation: 'set',
      palette: event.payload,
      acceptedDeviceId: event.deviceId,
      acceptedSessionId: event.sessionId,
      occurredAtClient: event.occurredAtClient,
      updatedAtServer: {},
    },
    receipt: {},
  }), { now: () => clock });
  assert.equal(await worker.flushOne(clock), 'apply');
  assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
  assert.equal((await getSyncMetaV5(ownerKey, 'annotation-palette')).knownRevision, 1);
  await worker.dispose();
});
