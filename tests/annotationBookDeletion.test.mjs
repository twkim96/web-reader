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
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const { ProgressSyncWorker } = await import('../src/lib/progressSyncWorker.ts');
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

test('a newly created highlight waits without cancelling a queued book deletion', async () => {
  await removeBookAndAnnotationsV8(
    ownerKey,
    DEVICE_CONTENT_OWNER_KEY,
    'book-1',
    context,
  );
  const db = await initDB();
  assert.ok(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']));
  await saveLocalAnnotationV8(ownerKey, annotation('new-highlight'), context);
  const intent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']);
  const events = await getOutboxEventsV5(ownerKey);
  const marker = events.find(({ target }) => (
    target.annotationId === 'book_delete_marker_v1'
  ));
  const highlight = events.find(({ target }) => target.annotationId === 'new-highlight');
  assert.equal(intent.markerEventId, marker.eventId);
  assert.equal(marker.status, 'pending');
  assert.equal(highlight.status, 'pending');
  assert.equal(highlight.awaitingBookGeneration, true);
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
  }, expectedClaim, now + 3, 1);
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

const ackMarker = async (owner, bookId, { revision = 1, headRevision = revision } = {}) => {
  const markerId = 'book_delete_marker_v1';
  const activeOwner = ownerRuntime.activate(owner);
  const worker = new ProgressSyncWorker(activeOwner, 'marker-tab', async (event) => {
    assert.equal(event.target.annotationId, markerId);
    if (bookId) assert.equal(event.target.bookId, bookId);
    bookId = event.target.bookId;
    return {
      status: headRevision === revision ? 'apply' : 'already_applied',
      head: {
        ...head('fixture', headRevision, bookId),
        annotationId: markerId,
        acceptedEventId: headRevision === revision ? event.eventId : 'later-marker',
        operation: 'delete',
        annotation: null,
        bookGeneration: headRevision,
        deletedAtServer: {},
      },
      receipt: {
        schemaVersion: 1,
        eventId: event.eventId,
        targetKind: 'annotation',
        targetKey: event.targetKey,
        bookId,
        annotationId: markerId,
        revision,
        createdAtServer: {},
      },
    };
  });
  assert.equal(await worker.flushOne(), headRevision === revision ? 'apply' : 'already_applied');
  await worker.dispose();
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

test('cancelled deletion cannot enqueue forced tombstones after the server fetch', async () => {
  const cancelOwner = makeOwnerKey(makeFirebaseOwnerKey('cancel-delete'), 'library:local');
  await removeBookAndAnnotationsV8(cancelOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  await ackMarker(cancelOwner, 'book-1');
  const db = await initDB();
  const result = await reconcileAnnotationBookDeletionIntentsV10('cancel-delete', cancelOwner, context, 900_000, async () => {
    await db.delete(V10_ANNOTATION_BOOK_DELETIONS_STORE, [cancelOwner, 'book-1']);
    return [head('late-remote', 3)];
  });
  assert.equal(result.queued, 0);
  assert.equal((await getOutboxEventsV5(cancelOwner)).some(event => event.target.annotationId === 'late-remote'), false);
});

test('uses its own replayed marker receipt and finishes when only newer work remains', async () => {
  await saveLocalAnnotationV8(ownerKey, annotation('pre-delete'), context);
  await removeBookAndAnnotationsV8(ownerKey, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  let calls = 0;
  await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, 10_000, async () => {
    calls++;
    return [head('remote-only', 3)];
  });
  assert.equal(calls, 0);
  const pendingEvents = await getOutboxEventsV5(ownerKey);
  assert.deepEqual(pendingEvents.map(({ target, status }) => [target.annotationId, status]).sort(), [
    ['book_delete_marker_v1', 'pending'],
    ['pre-delete', 'superseded'],
  ]);
  const marker = pendingEvents.find(event => event.target.annotationId === 'book_delete_marker_v1');
  await ackMarker(ownerKey, 'book-1', { revision: 2, headRevision: 3 });
  const db = await initDB();
  assert.equal((await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1'])).markerRevision, 2);
  assert.equal(await db.get(V5_OUTBOX_STORE, [ownerKey, marker.eventId]), undefined);
  assert.equal((await db.get(V5_REMOTE_HEADS_STORE, [ownerKey, marker.targetKey])).revision, 3);

  const safeHead = { ...head('same-id', 2), bookGeneration: 2 };
  const result = await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, 16_000, async () => {
    // A same-ID local edit produced while the fetch was running must remain intact.
    await saveLocalAnnotationV8(ownerKey, annotation('concurrent'), context);
    return [head('remote-only', 3), head('concurrent', 2), safeHead];
  });
  assert.equal(result.queued, 1);
  const events = (await getOutboxEventsV5(ownerKey)).filter(event => event.status === 'pending');
  const cleanup = events.find(event => event.target.annotationId === 'remote-only');
  assert.equal(cleanup.deleteBeforeBookGeneration, 2);
  assert.equal(cleanup.baseRevision, 3);
  assert.equal(events.find(event => event.target.annotationId === 'concurrent').operation, 'annotation.upsert');
  assert.equal(events.some(event => event.target.annotationId === 'same-id'), false);

  await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, 22_000,
    async () => [safeHead, { ...head('concurrent', 3), bookGeneration: 3 }]);
  assert.equal(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']), undefined);
});

test('a stale marker retires only its intent and releases edits at the observed remote generation', async () => {
  const staleOwner = makeOwnerKey(makeFirebaseOwnerKey('stale-marker'), 'library:local');
  const markerId = 'book_delete_marker_v1';
  const remoteMarker = (revision) => ({
    ...head('fixture', revision),
    annotationId: markerId,
    acceptedEventId: `marker-${revision}`,
    operation: 'delete',
    annotation: null,
    bookGeneration: revision,
    deletedAtServer: {},
  });
  const db = await initDB();
  const markerKey = [staleOwner, `annotation:book-1:${markerId}`];
  await db.put(V5_REMOTE_HEADS_STORE, {
    ownerKey: staleOwner, targetKey: markerKey[1], revision: 1, head: remoteMarker(1), updatedAt: 1,
  });
  await removeBookAndAnnotationsV8(staleOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  await saveLocalAnnotationV8(staleOwner, annotation('author-edit'), context);
  const worker = new ProgressSyncWorker(ownerRuntime.activate(staleOwner), 'stale-tab', async (event) => {
    assert.equal(event.target.annotationId, markerId);
    assert.equal(event.baseRevision, 1);
    return { status: 'superseded', remoteMarker: remoteMarker(2) };
  });
  assert.equal(await worker.flushOne(), 'superseded');
  await worker.dispose();

  const intentKey = [staleOwner, 'book-1'];
  const retired = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);
  assert.equal(retired.markerSuperseded, true);
  assert.equal(retired.markerRevision, undefined);
  assert.equal((await db.get(V5_OUTBOX_STORE, [staleOwner, retired.markerEventId])).status, 'superseded');
  assert.equal((await db.get(V5_REMOTE_HEADS_STORE, markerKey)).revision, 2);
  const result = await reconcileAnnotationBookDeletionIntentsV10('stale-marker', staleOwner, context, Date.now(),
    async () => assert.fail('a stale marker must not start cleanup'));
  assert.equal(result.queued, 0);

  const now = Date.now();
  const lease = await acquireSyncLeaseV5(staleOwner, 'next-tab', now);
  const edit = await claimNextProgressEventV5(staleOwner, 'next-tab', lease.epoch, now);
  assert.equal(edit.target.annotationId, 'author-edit');
  assert.equal(edit.bookGeneration, 2);
});

test('retires an intent whose marker was acknowledged by an old tab without its receipt', async () => {
  const mixedOwner = makeOwnerKey(makeFirebaseOwnerKey('mixed-marker-tab'), 'library:local');
  await removeBookAndAnnotationsV8(mixedOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  const db = await initDB();
  const [marker] = await getOutboxEventsV5(mixedOwner);
  const intentKey = [mixedOwner, 'book-1'];
  const before = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);
  await db.delete(V5_OUTBOX_STORE, [mixedOwner, marker.eventId]);

  const result = await reconcileAnnotationBookDeletionIntentsV10('mixed-marker-tab', mixedOwner, context, Date.now(),
    async () => assert.fail('an unproven marker must not start cleanup'));
  assert.equal(result.queued, 0);
  assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey), {
    ...before, markerSuperseded: true, lastErrorCode: 'sync/annotation-delete-unproven',
  });
});

test('an unsent cleanup does not replace a newer local edit of the same ID', async () => {
  const competingOwner = makeOwnerKey(makeFirebaseOwnerKey('edit-after-enqueue'), 'library:local');
  await removeBookAndAnnotationsV8(competingOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  await ackMarker(competingOwner, 'book-1');
  await reconcileAnnotationBookDeletionIntentsV10('edit-after-enqueue', competingOwner, context, 10_000,
    async () => [head('same-id', 4)]);
  const [deletion] = await getOutboxEventsV5(competingOwner);
  assert.equal(deletion.deleteBeforeBookGeneration, 1);
  await saveLocalAnnotationV8(competingOwner, annotation('same-id'), context);
  const events = await getOutboxEventsV5(competingOwner);
  assert.equal(events.find(event => event.eventId === deletion.eventId).status, 'superseded');
  const upsert = events.find(event => event.status === 'pending');
  assert.equal(upsert.operation, 'annotation.upsert');
  assert.equal(upsert.bookGeneration, 1);
  assert.equal(upsert.baseRevision, 4, 'the edit cannot use the unsent cleanup as a revision');
});

test('retires a skipped cleanup without recording a conflict or an acknowledgement', async () => {
  const skippedOwner = makeOwnerKey(makeFirebaseOwnerKey('skipped-cleanup'), 'library:local');
  await removeBookAndAnnotationsV8(skippedOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  await ackMarker(skippedOwner, 'book-1');
  await reconcileAnnotationBookDeletionIntentsV10('skipped-cleanup', skippedOwner, context, 10_000,
    async () => [head('changed-on-server', 4)]);
  const [queued] = await getOutboxEventsV5(skippedOwner);
  const worker = new ProgressSyncWorker(ownerRuntime.activate(skippedOwner), 'cleanup-tab', async (event) => {
    assert.equal(event.eventId, queued.eventId);
    return { status: 'superseded' };
  }, {
    acknowledge: async () => assert.fail('a skipped cleanup has no receipt'),
    recordConflict: async () => assert.fail('a skipped cleanup is not an edit conflict'),
  });
  assert.equal(await worker.flushOne(), 'superseded');
  await worker.dispose();
  const [skipped] = await getOutboxEventsV5(skippedOwner);
  assert.equal(skipped.eventId, queued.eventId);
  assert.equal(skipped.status, 'superseded');
  assert.equal(skipped.claimToken, null);
});

test('preserves legacy deletion evidence without sending or extending it', async () => {
  const db = await initDB();
  await removeBookAndAnnotationsV8(ownerKey, DEVICE_CONTENT_OWNER_KEY, 'book-1', context);
  const [marker] = await getOutboxEventsV5(ownerKey);
  await db.put(V5_OUTBOX_STORE, { ...marker, forceDelete: true });
  const original = { ownerKey, bookId: 'book-1', createdAt: 1, lastCheckedAt: null };
  await db.put(V10_ANNOTATION_BOOK_DELETIONS_STORE, original);
  const now = Date.now();
  const owner = ownerRuntime.activate(ownerKey);
  const worker = new ProgressSyncWorker(owner, 'legacy-tab', async () => assert.fail('legacy force-delete reached transport'));
  assert.equal(await worker.flushOne(), 'idle');
  await worker.dispose();
  assert.deepEqual(await db.get(V5_OUTBOX_STORE, [ownerKey, marker.eventId]), {
    ...marker, forceDelete: true, status: 'superseded', nextAttemptAt: null, lastErrorCode: 'sync/annotation-delete-unproven',
  });
  const result = await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, now + 1_000,
    async () => assert.fail('legacy intent queried deletion candidates'));
  assert.equal(result.queued, 0);
  assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']), {
    ...original, expired: true, recoveryPending: true, lastErrorCode: 'sync/annotation-delete-unproven',
  });
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
  await ackMarker(isolatedOwner);
  await ackMarker(isolatedOwner);
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

test('different-device intents retain their original authority and cannot generate forced deletes', async () => {
  const db = await initDB();
  const previousFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  const now = Date.now();
  const leasedId = `wl1_12345678-1234-4234-8234-123456789abc_${now}_12345678-1234-4234-8234-123456789def`;
  try {
    await db.put(V10_ANNOTATION_BOOK_DELETIONS_STORE, { ownerKey, bookId: 'book-1', createdAt: now,
      lastCheckedAt: null, markerEventId: leasedId, markerRevision: 1, writeLeaseEventId: leasedId, writeLeaseDeviceId: 'another-device' });
    let calls = 0;
    await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, now + 10_000, async () => { calls++; return [head('remote', 1)]; });
    let intent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']);
    assert.equal(intent.expired, undefined);
    assert.equal(intent.writeLeaseEventId, leasedId);
    assert.equal(intent.writeLeaseDeviceId, 'another-device');
    assert.equal(calls, 0);
    assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
    await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, now + 20_000, async () => { calls++; return [head('remote', 1)]; });
    intent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']);
    assert.equal(intent.expired, undefined);
    assert.equal(intent.writeLeaseEventId, leasedId);
    assert.equal(calls, 0);
    assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
  } finally {
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previousFlag;
  }
});
