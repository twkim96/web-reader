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
const { captureAnnotationBookDeletionV5, reconcileAnnotationBookDeletionIntentsV10 } = await import(
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
const { getLocalAnnotationsV8, saveLocalAnnotationV8 } = await import('../src/lib/localAnnotations.ts');
const { toAnnotationSyncPayloadV1 } = await import('../src/lib/annotationSyncSchema.ts');
const { decideAnnotationTransaction } = await import('../src/lib/annotationSyncTransaction.ts');
const { ANNOTATION_BOOK_DELETE_MARKER_ID } = await import('../src/lib/annotationPolicy.ts');
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

  const waiting = await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, 22_000,
    async () => { throw new Error('unexpected fetch while the cleanup is ready to send'); });
  assert.equal(waiting.failed, 0);
  assert.ok(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']));
  await reconcileAnnotationBookDeletionIntentsV10('book-delete', ownerKey, context, 46_000,
    async () => [safeHead, { ...head('concurrent', 3), bookGeneration: 3 }]);
  assert.equal(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, 'book-1']), undefined);
});

test('a repeat deletion during marker acknowledgement preserves the first receipt and generation fence', async () => {
  const owner = makeOwnerKey(makeFirebaseOwnerKey('repeat-delete'), 'library:local');
  const bookId = 'repeat-book';
  await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context);
  const now = Date.now() + 1_000;
  const lease = await acquireSyncLeaseV5(owner, 'repeat-tab', now, 5_000);
  const sent = await claimNextProgressEventV5(owner, 'repeat-tab', lease.epoch, now + 1);
  const intentKey = [owner, bookId];
  const db = await initDB();
  const first = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);

  await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context);
  assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey), first);
  assert.deepEqual((await getOutboxEventsV5(owner)).map(event => event.eventId), [sent.eventId]);
  const marker = {
    ...head('fixture', 2, bookId), annotationId: sent.target.annotationId, acceptedEventId: 'next-marker',
    operation: 'delete', annotation: null, bookGeneration: 2, deletedAtServer: {},
  };
  assert.equal(await acknowledgeProgressEventV5(owner, sent.eventId, marker, getExpectedClaimV5(sent), now + 2, 1), true);
  assert.equal((await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey)).markerRevision, 1);
  const result = await reconcileAnnotationBookDeletionIntentsV10('repeat-delete', owner, context, now + 3, async () => [
    head('before-delete', 1, bookId),
    { ...head('newer-highlight', 1, bookId), bookGeneration: 1 },
  ]);
  assert.equal(result.queued, 1);
  const [cleanup] = await getOutboxEventsV5(owner);
  assert.equal(cleanup.target.annotationId, 'before-delete');
  assert.equal(cleanup.deleteBeforeBookGeneration, 1);
});

for (const state of ['queued', 'submitted']) {
  test(`a repeat shelf confirmation preserves the first ${state} marker when its ACK arrives before removal`, async () => {
    const uid = `repeat-confirmation-${state}`;
    const owner = makeOwnerKey(makeFirebaseOwnerKey(uid), 'library:local');
    const bookId = 'book-1';
    const db = await initDB();
    await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context);
    const currentMarker = () => captureAnnotationBookDeletionV5(owner, bookId, async () => {
      assert.fail('a repeated confirmation must use the existing local intent');
    });
    let repeated = state === 'queued' ? await currentMarker() : undefined;
    const worker = new ProgressSyncWorker(ownerRuntime.activate(owner), 'deleting-tab', async (event) => {
      const first = decideAnnotationTransaction({ event, serverTime: {} });
      if (state === 'submitted') repeated = await currentMarker();
      return first;
    });
    assert.equal(await worker.flushOne(), 'apply');
    await worker.dispose();

    const acknowledged = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [owner, bookId]);
    assert.equal(acknowledged.markerRevision, 1);
    await saveLocalAnnotationV8(owner, annotation('new-local-highlight', bookId), context);
    const pendingBeforeRepeat = await getOutboxEventsV5(owner);
    assert.equal(pendingBeforeRepeat.length, 1);
    await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context, repeated);
    assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [owner, bookId]), acknowledged);
    assert.deepEqual(await getOutboxEventsV5(owner), pendingBeforeRepeat);
    const cleanup = await reconcileAnnotationBookDeletionIntentsV10(uid, owner, context, Date.now(), async () => [
      { ...head('created-after-first-marker', 1, bookId), bookGeneration: 1 },
    ]);
    assert.equal(cleanup.queued, 0);
  });
}

for (const phase of ['old-read', 'new-read', 'cleanup-finished']) {
  test(`overlapping shelf deletions retain the first cleanup with ${phase}`, async () => {
    const uid = `overlapping-deletion-${phase}`;
    const owner = makeOwnerKey(makeFirebaseOwnerKey(uid), 'library:local');
    const bookId = 'book-1';
    const intentKey = [owner, bookId];
    const db = await initDB();
    const first = await captureAnnotationBookDeletionV5(owner, bookId, async () => null);
    let startRead;
    let finishRead;
    const readStarted = new Promise(resolve => { startRead = resolve; });
    const remoteRead = new Promise(resolve => { finishRead = resolve; });
    const second = captureAnnotationBookDeletionV5(owner, bookId, () => {
      startRead();
      return remoteRead;
    });
    await readStarted;

    let remote;
    const worker = new ProgressSyncWorker(ownerRuntime.activate(owner), 'shared-leader', async (event) => {
      const result = decideAnnotationTransaction({
        event, storedHead: remote?.head, storedAggregate: remote?.aggregate,
        storedBookDeleteMarker: remote?.head, serverTime: {},
      });
      if (result.status === 'apply') remote = result;
      return result;
    });
    try {
      await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context, first);
      assert.equal(await worker.flushOne(), 'apply');
      const cleanupFinished = phase === 'cleanup-finished';
      const newer = { ...head('after-first-marker', 1, bookId), bookGeneration: 1 };
      if (cleanupFinished) {
        await reconcileAnnotationBookDeletionIntentsV10(uid, owner, context, 10_000, async () => [newer]);
        assert.equal(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey), undefined);
      }
      await saveLocalAnnotationV8(owner, annotation('new-local-highlight', bookId), context);
      const intentBefore = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);
      const outboxBefore = await getOutboxEventsV5(owner);

      finishRead(phase === 'old-read' ? null : remote.head);
      await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, bookId, context, await second);
      assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey), intentBefore);
      assert.deepEqual(await getOutboxEventsV5(owner), outboxBefore);
      assert.deepEqual((await getLocalAnnotationsV8(owner, bookId)).map(({ id }) => id), ['new-local-highlight']);
      const result = await reconcileAnnotationBookDeletionIntentsV10(uid, owner, context, 20_000, async () => {
        assert.equal(cleanupFinished, false, 'a completed cleanup must not run again');
        return [head('before-first-marker', 1, bookId), newer];
      });
      assert.equal(result.queued, cleanupFinished ? 0 : 1);
      assert.deepEqual((await getOutboxEventsV5(owner))
        .filter(event => event.operation === 'annotation.delete')
        .map(event => [event.target.annotationId, event.deleteBeforeBookGeneration]),
      cleanupFinished ? [] : [['before-first-marker', 1]]);
    } finally {
      await worker.dispose();
    }
  });
}

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
  const observed = await captureAnnotationBookDeletionV5(staleOwner, 'book-1', async () => {
    assert.fail('a known marker is the basis for deletion');
  });
  await removeBookAndAnnotationsV8(staleOwner, DEVICE_CONTENT_OWNER_KEY, 'book-1', context, observed);
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

for (const markerMoved of [false, true]) {
  test(`deletion from a cold shelf ${markerMoved ? 'does not expand to a concurrent generation' : 'cleans up a book with an earlier deletion'}`, async () => {
    const uid = markerMoved ? 'cold-shelf-marker-moved' : 'cold-shelf';
    const coldOwner = makeOwnerKey(makeFirebaseOwnerKey(uid), 'library:local');
    const bookId = 'readded-book';
    const markerId = ANNOTATION_BOOK_DELETE_MARKER_ID;
    const targetKey = `annotation:${bookId}:${markerId}`;
    const previousEvent = {
      eventId: 'previous-deletion', targetKey,
      target: { kind: 'annotation', bookId, annotationId: markerId },
      operation: 'annotation.delete', payload: null, baseRevision: 0,
      ...context, occurredAtClient: 1,
    };
    const previous = decideAnnotationTransaction({ event: previousEvent, serverTime: {} });
    assert.equal(previous.status, 'apply');
    const earlierHighlight = { ...head('readded-highlight', 1, bookId), bookGeneration: previous.head.revision };
    const readBack = await captureAnnotationBookDeletionV5(coldOwner, bookId, async () => previous.head);
    const db = await initDB();
    assert.equal(await db.get(V5_REMOTE_HEADS_STORE, [coldOwner, targetKey]), undefined);

    const remote = markerMoved ? decideAnnotationTransaction({
      event: { ...previousEvent, eventId: 'concurrent-deletion', baseRevision: previous.head.revision },
      storedHead: previous.head, storedAggregate: previous.aggregate, storedBookDeleteMarker: previous.head,
      serverTime: {},
    }) : previous;
    assert.equal(remote.status, 'apply');
    await removeBookAndAnnotationsV8(coldOwner, DEVICE_CONTENT_OWNER_KEY, bookId, context, readBack);
    const worker = new ProgressSyncWorker(ownerRuntime.activate(coldOwner), 'cold-shelf-tab', async (event) => (
      decideAnnotationTransaction({
        event, storedHead: remote.head, storedAggregate: remote.aggregate, storedBookDeleteMarker: remote.head,
        serverTime: {},
      })
    ));
    assert.equal(await worker.flushOne(), markerMoved ? 'superseded' : 'apply');
    await worker.dispose();

    const intent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [coldOwner, bookId]);
    const result = await reconcileAnnotationBookDeletionIntentsV10(uid, coldOwner, context, Date.now(), async () => {
      if (markerMoved) assert.fail('a later remote generation cannot start cleanup for this request');
      return [earlierHighlight, { ...head('new-highlight', 1, bookId), bookGeneration: 2 }];
    });
    assert.equal(result.queued, markerMoved ? 0 : 1);
    if (markerMoved) {
      assert.equal(intent.markerSuperseded, true);
    } else {
      assert.equal(intent.markerRevision, 2);
      const [cleanup] = await getOutboxEventsV5(coldOwner);
      assert.equal(cleanup.target.annotationId, 'readded-highlight');
      assert.equal(cleanup.deleteBeforeBookGeneration, 2);
    }
  });
}

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
    const waiting = await reconcileAnnotationBookDeletionIntentsV10('skipped-cleanup', skippedOwner, context, 16_000,
      async () => { throw new Error('unexpected fetch while a cleanup is in flight'); });
    assert.equal(waiting.failed, 0);
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
  let checked = false;
  await reconcileAnnotationBookDeletionIntentsV10('skipped-cleanup', skippedOwner, context, 22_000, async () => {
    checked = true;
    return [];
  });
  assert.ok(checked, 'the next reconciliation verifies completion once the cleanup is retired');
  assert.equal(await (await initDB()).get(V10_ANNOTATION_BOOK_DELETIONS_STORE, [skippedOwner, 'book-1']), undefined);
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
