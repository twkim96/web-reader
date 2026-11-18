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

test('retried annotation and palette edits retain submitted payloads under their original IDs', async () => {
  const { acquireSyncLeaseV5, claimNextProgressEventV5, getExpectedClaimV5, scheduleProgressEventRetryV5 } = await import('../src/lib/syncOutboxV5.ts');
  const context = syncContext();
  await saveLocalAnnotationV8(ownerKey, annotation('retry'), context);
  const originalPalette = { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) };
  await enqueueAnnotationPaletteEventV5(ownerKey, { payload: originalPalette, occurredAtClient: 1 }, context);
  const lease = await acquireSyncLeaseV5(ownerKey, 'tab', Date.now(), 10000);
  for (let i = 0; i < 2; i++) {
    const event = await claimNextProgressEventV5(ownerKey, 'tab', lease.epoch, Date.now());
    assert.ok(event);
    await scheduleProgressEventRetryV5(ownerKey, event.eventId, 'unavailable', getExpectedClaimV5(event), Date.now(), 0);
  }
  await updateLocalAnnotationNoteV8(ownerKey, 'book-1', 'retry', 'new note', context);
  const newPalette = { items: originalPalette.items.map((item, i) => i === 0 ? { ...item, meaning: 'new meaning' } : item) };
  await enqueueAnnotationPaletteEventV5(ownerKey, { payload: newPalette }, context);
  const events = await getOutboxEventsV5(ownerKey);
  for (const kind of ['annotation', 'palette']) {
    const pair = events.filter((event) => event.target.kind === kind);
    assert.equal(pair.length, 2);
    assert.notEqual(pair[0].eventId, pair[1].eventId);
    assert.equal(pair[0].attempts, 1);
    assert.equal(pair[1].attempts, 0);
    if (kind === 'annotation') {
      assert.equal(pair[0].payload.note, '');
      assert.equal(pair[1].payload.note, 'new note');
    } else {
      assert.deepEqual(pair[0].payload, originalPalette);
      assert.deepEqual(pair[1].payload, newPalette);
    }
  }
});

test('expired book deletion blocks a new annotation without deleting its recovery intent', async () => {
  const previous = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  try {
    const db = await initDB();
    const intent = { ownerKey, bookId: 'book-1', createdAt: 1, lastCheckedAt: null,
      expired: true, recoveryPending: true, writeLeaseEventId: 'unleased_original' };
    await db.put('annotation-book-deletions-v10', intent);
    await assert.rejects(saveLocalAnnotationV8(ownerKey, annotation('new-during-recovery'), syncContext()), { code: 'sync/resync-required' });
    await assert.rejects(saveLocalAnnotationV8(ownerKey, annotation('new-without-sync-context')), { code: 'sync/resync-required' });
    assert.deepEqual(await db.get('annotation-book-deletions-v10', [ownerKey, 'book-1']), intent);
    assert.deepEqual(await getLocalAnnotationsV8(ownerKey, 'book-1'), []);
    assert.deepEqual(await getOutboxEventsV5(ownerKey), []);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previous;
  }
});

for (const kind of ['annotation', 'palette']) {
  test(`pending ${kind} recovery cannot be bypassed by a new conflict`, async () => {
    const db = await initDB();
    const context = syncContext();
    if (kind === 'annotation') await saveLocalAnnotationV8(ownerKey, annotation('recovery'), context);
    else await enqueueAnnotationPaletteEventV5(ownerKey, { payload: { items: DEFAULT_ANNOTATION_PALETTE } }, context);
    const event = (await getOutboxEventsV5(ownerKey))[0];
    const { V5_OUTBOX_STORE } = await import('../src/lib/localDBSchema.ts');
    const expired = { ...event, status: 'expired', recoveryPending: true };
    await db.put(V5_OUTBOX_STORE, expired);
    const conflict = { ownerKey, conflictId: 'late-conflict', state: 'open', targetKey: event.targetKey,
      event, remoteHead: null, latestLocalPosition: event.payload, blockedEventIds: [event.eventId], createdAt: 1 };
    await db.put('sync-conflicts-v5', conflict);
    const previous = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
    try {
      const mutate = kind === 'annotation'
        ? updateLocalAnnotationNoteV8(ownerKey, 'book-1', 'recovery', 'must not apply', context)
        : enqueueAnnotationPaletteEventV5(ownerKey, { payload: { items: DEFAULT_ANNOTATION_PALETTE } }, context);
      await assert.rejects(mutate, { code: 'sync/resync-required' });
      assert.deepEqual(await db.get('sync-conflicts-v5', [ownerKey, conflict.conflictId]), conflict);
      assert.deepEqual(await db.get(V5_OUTBOX_STORE, [ownerKey, event.eventId]), expired);
      if (kind === 'annotation') assert.equal((await getLocalAnnotationsV8(ownerKey, 'book-1'))[0].note, '');
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
      else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previous;
    }
  });
}
