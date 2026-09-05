import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  acknowledgeProgressEventV5,
  adoptRemoteProgressLocallyV5,
  acquireSyncLeaseV5,
  claimNextProgressEventV5,
  enqueueBookmarkEventV5,
  enqueueProgressMutationBatchV5,
  enqueueProgressEventV5,
  getExpectedClaimV5,
  getOpenSyncConflictsV5,
  getUnresolvedSyncConflictsV5,
  getOutboxEventsV5,
  getPausedSyncSummaryV5,
  getRetryDelayMs,
  getSyncMetaV5,
  recoverExpiredInFlightEventsV5,
  releaseSyncLeaseV5,
  recordProgressConflictV5,
  deferSyncConflictV5,
  markRemoteProgressIgnoredV5,
  pauseProgressEventV5,
  previewSyncConflictUseRemoteProgressV5,
  resumePausedAuthEventsV5,
  resolveSyncConflictKeepLocalV5,
  resolveSyncConflictUseRemoteV5,
  scheduleProgressEventRetryV5,
  storeRemoteHeadsBatchV5,
  storeRemoteProgressHeadV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
const {
  makeFirebaseOwnerKey,
  makeOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('a'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('b'), 'library:local');
const position = (percent) => ({
  cfi: `epubcfi(/6/${percent})`,
  anchorCfi: null,
  progressPercent: percent,
});

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

const enqueue = (ownerKey, overrides = {}) => enqueueProgressEventV5(ownerKey, {
  bookId: 'book-1',
  operation: 'progress.set',
  position: position(10),
  deviceId: 'device-1',
  sessionId: 'session-1',
  occurredAtClient: 1,
  ...overrides,
});

const claimNext = async (now = 10, tabId = 'tab-a') => {
  const lease = await acquireSyncLeaseV5(ownerA, tabId, now, 50);
  const event = await claimNextProgressEventV5(
    ownerA,
    tabId,
    lease.epoch,
    now + 1,
    () => `${tabId}-claim-${now}`,
  );
  const expectedClaim = getExpectedClaimV5(event);
  assert.ok(expectedClaim);
  return { event, expectedClaim, lease };
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('coalesces only the last same-session pending progress.set', async () => {
  const first = await enqueue(ownerA, { eventId: 'event-1' });
  const second = await enqueue(ownerA, {
    eventId: 'event-ignored',
    position: position(30),
    occurredAtClient: 2,
  });
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'event-1');
  assert.equal(events[0].payload.progressPercent, 30);
  assert.equal(events[0].baseRevision, 0);
  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).nextSequence, 2);
});

test('an observed in-flight echo does not double count the next base revision', async () => {
  await enqueue(ownerA, { eventId: 'event-1', sessionId: 'session-a' });
  const claimed = await claimNext(10);
  assert.equal(claimed.event.baseRevision, 0);

  await storeRemoteProgressHeadV5(ownerA, {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'event-1',
    operation: 'set',
    position: position(10),
    acceptedDeviceId: 'device-1',
    acceptedSessionId: 'session-a',
    occurredAtClient: 1,
    updatedAtServer: {},
    deletedAtServer: null,
  }, 12);

  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).knownRevision, 0);
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-b',
    position: position(20),
    occurredAtClient: 13,
  });
  const events = await getOutboxEventsV5(ownerA, 'progress:book-1');
  assert.equal(events.find(({ eventId }) => eventId === 'event-2').baseRevision, 1);
});

test('reports paused sync and resumes recoverable auth or rules deployment failures', async () => {
  await enqueue(ownerA, { eventId: 'auth-event' });
  const authClaim = await claimNext(10);
  await pauseProgressEventV5(
    ownerA,
    authClaim.event.eventId,
    'unauthenticated',
    authClaim.expectedClaim,
  );
  await enqueue(ownerA, {
    eventId: 'permission-event',
    bookId: 'book-2',
    occurredAtClient: 2,
  });
  const permissionClaim = await claimNext(12);
  await pauseProgressEventV5(
    ownerA,
    permissionClaim.event.eventId,
    'permission-denied',
    permissionClaim.expectedClaim,
  );
  await enqueue(ownerA, {
    eventId: 'id-token-event',
    bookId: 'book-3',
    occurredAtClient: 3,
  });
  const idTokenClaim = await claimNext(14);
  await pauseProgressEventV5(
    ownerA,
    idTokenClaim.event.eventId,
    'auth/id-token-expired',
    idTokenClaim.expectedClaim,
  );

  assert.deepEqual(await getPausedSyncSummaryV5(ownerA), {
    count: 3,
    errorCodes: ['unauthenticated', 'auth/id-token-expired', 'permission-denied'],
  });
  assert.equal(await resumePausedAuthEventsV5(ownerA, 20), 3);
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(events.find(({ eventId }) => eventId === 'auth-event').status, 'pending');
  assert.equal(events.find(({ eventId }) => eventId === 'permission-event').status, 'pending');
  assert.equal(events.find(({ eventId }) => eventId === 'id-token-event').status, 'pending');
});

test('adopts a verified remote position locally without creating an outbox event', async () => {
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 7,
    acceptedEventId: 'remote-7',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other-device',
    acceptedSessionId: 'other-session',
    occurredAtClient: 7,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  await storeRemoteProgressHeadV5(ownerA, remote, 10);
  const adoption = await adoptRemoteProgressLocallyV5(ownerA, {
    operation: 'set',
    bookId: 'book-1',
    cfi: remote.position.cfi,
    anchorCfi: remote.position.cfi,
    progressPercent: 70,
    lastRead: 10,
    syncRevision: 7,
    acceptedEventId: 'remote-7',
  });
  assert.equal(adoption.status, 'adopted');
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  const [saved] = await getAllLocalProgressV5(ownerA);
  assert.equal(saved.progressPercent, 70);
  assert.equal(saved.syncRevision, 7);
});

test('aborts remote adoption atomically when user intent cancels the navigation attempt', async () => {
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 7,
    acceptedEventId: 'remote-7',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other-device',
    acceptedSessionId: 'other-session',
    occurredAtClient: 7,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  await storeRemoteProgressHeadV5(ownerA, remote, 10);
  const controller = new AbortController();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function abortAfterCanonicalProgressWrite(...args) {
    const request = originalPut.apply(this, args);
    if (this.name === 'progress-v5') controller.abort();
    return request;
  };
  try {
    const adoption = await adoptRemoteProgressLocallyV5(ownerA, {
      operation: 'set',
      bookId: 'book-1',
      cfi: remote.position.cfi,
      anchorCfi: remote.position.cfi,
      progressPercent: 70,
      lastRead: 10,
      syncRevision: 7,
      acceptedEventId: 'remote-7',
    }, 11, controller.signal);
    assert.equal(adoption.status, 'cancelled');
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await getAllLocalProgressV5(ownerA)).length, 0);
});

test('refuses quiet remote adoption while the progress target has local outbox intent', async () => {
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 7,
    acceptedEventId: 'remote-7',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other-device',
    acceptedSessionId: 'other-session',
    occurredAtClient: 7,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  await storeRemoteProgressHeadV5(ownerA, remote, 10);
  await enqueue(ownerA, {
    eventId: 'local-30',
    position: position(30),
    occurredAtClient: 11,
  });

  const adoption = await adoptRemoteProgressLocallyV5(ownerA, {
    operation: 'set',
    bookId: 'book-1',
    cfi: remote.position.cfi,
    anchorCfi: remote.position.cfi,
    progressPercent: 70,
    lastRead: 10,
    syncRevision: 7,
    acceptedEventId: 'remote-7',
  });
  assert.equal(adoption.status, 'blocked-by-local-work');
  assert.equal(adoption.work.pending, 1);
  assert.equal((await getOutboxEventsV5(ownerA))[0].payload.progressPercent, 30);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  const [saved] = await getAllLocalProgressV5(ownerA);
  assert.equal(saved.progressPercent, 30);
});

test('builds an expected revision chain for distinct sessions and reset', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    position: position(20),
    occurredAtClient: 2,
  });
  await enqueue(ownerA, {
    eventId: 'event-3',
    operation: 'progress.reset',
    position: null,
    occurredAtClient: 3,
  });
  const events = await getOutboxEventsV5(ownerA);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3]);
  assert.deepEqual(events.map(({ baseRevision }) => baseRevision), [0, 1, 2]);
});

test('adopts an authoritative remote reset without creating local sync intent', async () => {
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 8,
    acceptedEventId: 'remote-reset-8',
    operation: 'reset',
    position: null,
    acceptedDeviceId: 'other-device',
    acceptedSessionId: 'other-session',
    occurredAtClient: 8,
    updatedAtServer: {},
    deletedAtServer: {},
  };
  await storeRemoteProgressHeadV5(ownerA, remote, 10);
  const adoption = await adoptRemoteProgressLocallyV5(ownerA, {
    operation: 'reset',
    bookId: 'book-1',
    cfi: '',
    anchorCfi: '',
    progressPercent: 0,
    lastRead: 10,
    bookmarks: [],
    syncRevision: 8,
    acceptedEventId: 'remote-reset-8',
  });
  assert.equal(adoption.status, 'adopted');
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  const [saved] = await getAllLocalProgressV5(ownerA);
  assert.equal(saved.cfi, '');
  assert.equal(saved.progressPercent, 0);
  assert.equal(saved.syncRevision, 8);
});

test('isolates owner outboxes and allows only one live lease holder', async () => {
  await enqueue(ownerA, { eventId: 'a' });
  await enqueue(ownerB, { eventId: 'b' });
  assert.deepEqual((await getOutboxEventsV5(ownerA)).map(({ eventId }) => eventId), ['a']);
  assert.deepEqual((await getOutboxEventsV5(ownerB)).map(({ eventId }) => eventId), ['b']);

  const leaseA = await acquireSyncLeaseV5(ownerA, 'tab-a', 100, 50);
  assert.equal(leaseA.epoch, 1);
  assert.equal(await acquireSyncLeaseV5(ownerA, 'tab-b', 120, 50), null);
  const leaseB = await acquireSyncLeaseV5(ownerA, 'tab-b', 151, 50);
  assert.equal(leaseB.epoch, 2);
  assert.equal(await claimNextProgressEventV5(ownerA, 'tab-a', 1, 152), null);
  assert.equal((await claimNextProgressEventV5(ownerA, 'tab-b', 2, 152)).eventId, 'a');
});

test('issues a new epoch when the same tab reacquires an expired lease', async () => {
  const first = await acquireSyncLeaseV5(ownerA, 'tab-a', 100, 50);
  const renewed = await acquireSyncLeaseV5(ownerA, 'tab-a', 120, 50);
  const reacquired = await acquireSyncLeaseV5(ownerA, 'tab-a', 171, 50);
  assert.equal(first.epoch, 1);
  assert.equal(renewed.epoch, 1);
  assert.equal(reacquired.epoch, 2);
});

test('conflict preserves the event and blocks its later chain', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    position: position(35),
    occurredAtClient: 2,
  });
  const { expectedClaim } = await claimNext();
  const conflict = await recordProgressConflictV5(
    ownerA,
    'event-1',
    null,
    expectedClaim,
    12,
  );
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(conflict.state, 'open');
  assert.equal(conflict.latestLocalPosition.progressPercent, 35);
  assert.deepEqual(conflict.blockedEventIds, ['event-2']);
  assert.deepEqual(events.map(({ status }) => status), ['conflict', 'blocked']);

  const deferred = await enqueue(ownerA, {
    eventId: 'event-3',
    sessionId: 'session-3',
    position: position(80),
    occurredAtClient: 4,
  });
  assert.equal(deferred.deferredByConflict, true);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 2);
});

test('resolves a pre-existing blocked progress chain from canonical local progress', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    position: position(35),
    occurredAtClient: 2,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 4,
    acceptedEventId: 'remote-4',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  const conflict = await recordProgressConflictV5(
    ownerA,
    'event-1',
    remote,
    expectedClaim,
    12,
  );
  assert.equal(conflict.latestLocalPosition.progressPercent, 35);
  const replacement = await resolveSyncConflictKeepLocalV5(ownerA, 'event-1', 20);
  assert.equal(replacement.payload.progressPercent, 35);
});

test('preserves canonical local progress when accepting a remote blocked-chain conflict', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    position: position(35),
    occurredAtClient: 2,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 4,
    acceptedEventId: 'remote-4',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  const conflict = await recordProgressConflictV5(
    ownerA,
    'event-1',
    remote,
    expectedClaim,
    12,
  );
  const resolved = await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    20,
    true,
    { kind: 'position', position: conflict.latestLocalPosition },
  );
  assert.equal(resolved.progressPercent, 70);
  const recovery = resolved.bookmarks.find(({ name }) => name === '충돌 전 위치');
  assert.equal(recovery.progressPercent, 35);
  assert.equal(recovery.cfi, position(35).cfi);
});

test('persists conflict deferral and reopens it only after expiry or a new local mutation', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', null, expectedClaim, 12);
  assert.equal(await deferSyncConflictV5(ownerA, 'event-1', 20, 100), true);
  assert.deepEqual(await getOpenSyncConflictsV5(ownerA, 119), []);
  assert.equal((await getUnresolvedSyncConflictsV5(ownerA))[0].state, 'deferred');
  assert.equal((await getOpenSyncConflictsV5(ownerA, 120))[0].conflictId, 'event-1');

  await deferSyncConflictV5(ownerA, 'event-1', 200, 100);
  const deferred = await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    position: position(35),
    occurredAtClient: 210,
  });
  assert.equal(deferred.deferredByConflict, true);
  const [reopened] = await getOpenSyncConflictsV5(ownerA, 211);
  assert.equal(reopened.state, 'open');
  assert.equal(reopened.latestLocalPosition.progressPercent, 35);
});

test('persists the highest explicitly ignored remote progress revision', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  assert.equal(await markRemoteProgressIgnoredV5(ownerA, 'book-1', 7), true);
  assert.equal(await markRemoteProgressIgnoredV5(ownerA, 'book-1', 5), true);
  const [stored] = await getAllLocalProgressV5(ownerA);
  assert.equal(stored.ignoredRemoteRevision, 7);
});

test('persists an ignored remote revision before a local progress row exists', async () => {
  assert.equal(await markRemoteProgressIgnoredV5(ownerA, 'book-empty', 11), true);
  const stored = (await getAllLocalProgressV5(ownerA))
    .find(({ bookId }) => bookId === 'book-empty');
  assert.ok(stored);
  assert.equal(stored.cfi, '');
  assert.equal(stored.progressPercent, 0);
  assert.equal(stored.ignoredRemoteRevision, 11);
});

test('ack advances known revision monotonically and removes only its event', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  const head = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 5,
    acceptedEventId: 'event-1',
    operation: 'set',
    position: position(10),
    acceptedDeviceId: 'device-1',
    occurredAtClient: 1,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  assert.equal(await acknowledgeProgressEventV5(
    ownerA,
    'event-1',
    head,
    expectedClaim,
    12,
  ), true);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).knownRevision, 5);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  const [saved] = await getAllLocalProgressV5(ownerA);
  assert.equal(saved.syncRevision, 5);
  assert.equal(saved.acceptedEventId, 'event-1');
  await enqueue(ownerA, {
    eventId: 'event-after-remote',
    sessionId: 'session-after-remote',
    occurredAtClient: 5,
  });
  const next = (await getOutboxEventsV5(ownerA))
    .find(({ eventId }) => eventId === 'event-after-remote');
  assert.equal(next.baseRevision, 5);
});

test('does not claim behind in-flight work and recovers only after lease takeover', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    occurredAtClient: 2,
  });
  const firstLease = await acquireSyncLeaseV5(ownerA, 'tab-a', 100, 50);
  assert.equal((await claimNextProgressEventV5(ownerA, 'tab-a', firstLease.epoch, 101)).eventId, 'event-1');
  assert.equal(await claimNextProgressEventV5(ownerA, 'tab-a', firstLease.epoch, 102), null);

  const nextLease = await acquireSyncLeaseV5(ownerA, 'tab-b', 151, 50);
  assert.equal(await recoverExpiredInFlightEventsV5(ownerA, 'tab-b', nextLease.epoch, 152), 1);
  assert.equal((await claimNextProgressEventV5(ownerA, 'tab-b', nextLease.epoch, 153)).eventId, 'event-1');
});

test('release preserves the lease generation so a new tab recovers the stale claim', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  const firstLease = await acquireSyncLeaseV5(ownerA, 'tab-a', 100, 50);
  await claimNextProgressEventV5(ownerA, 'tab-a', firstLease.epoch, 101);
  await releaseSyncLeaseV5(ownerA, 'tab-a', firstLease.epoch);

  const nextLease = await acquireSyncLeaseV5(ownerA, 'tab-b', 102, 50);
  assert.ok(nextLease.epoch > firstLease.epoch);
  assert.equal(await recoverExpiredInFlightEventsV5(
    ownerA,
    'tab-b',
    nextLease.epoch,
    103,
  ), 1);
  assert.equal((await claimNextProgressEventV5(
    ownerA,
    'tab-b',
    nextLease.epoch,
    104,
  )).eventId, 'event-1');
});

test('late mutations cannot change an event reclaimed by a newer lease', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  const leaseA = await acquireSyncLeaseV5(ownerA, 'tab-a', 100, 50);
  const eventA = await claimNextProgressEventV5(
    ownerA,
    'tab-a',
    leaseA.epoch,
    101,
    () => 'claim-a',
  );
  const expectedA = getExpectedClaimV5(eventA);
  assert.ok(expectedA);

  const leaseB = await acquireSyncLeaseV5(ownerA, 'tab-b', 151, 50);
  await recoverExpiredInFlightEventsV5(ownerA, 'tab-b', leaseB.epoch, 152);
  const eventB = await claimNextProgressEventV5(
    ownerA,
    'tab-b',
    leaseB.epoch,
    153,
    () => 'claim-b',
  );
  const head = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'event-1',
    operation: 'set',
    position: position(10),
    acceptedDeviceId: 'device-1',
    occurredAtClient: 1,
    updatedAtServer: {},
    deletedAtServer: null,
  };

  assert.equal(await acknowledgeProgressEventV5(
    ownerA, 'event-1', head, expectedA, 154,
  ), false);
  assert.equal(await scheduleProgressEventRetryV5(
    ownerA, 'event-1', 'unavailable', expectedA, 154, 0,
  ), null);
  assert.equal(await pauseProgressEventV5(
    ownerA, 'event-1', 'permission-denied', expectedA,
  ), null);
  assert.equal(await recordProgressConflictV5(
    ownerA, 'event-1', head, expectedA, 154,
  ), false);

  const current = (await getOutboxEventsV5(ownerA))[0];
  assert.equal(current.status, 'in_flight');
  assert.equal(current.claimedByTabId, 'tab-b');
  assert.equal(current.claimedLeaseEpoch, leaseB.epoch);
  assert.equal(current.claimToken, 'claim-b');
  assert.equal(eventB.claimToken, 'claim-b');
});

test('retry delay uses bounded exponential backoff with jitter', () => {
  assert.equal(getRetryDelayMs(1, 0), 1_000);
  assert.equal(getRetryDelayMs(2, 0.5), 2_200);
  assert.equal(getRetryDelayMs(20, 1), 60_000);
});

test('coalesces the last same-session unclaimed bookmark intent', async () => {
  const local = {
    id: 'same',
    type: 'manual',
    name: 'local',
    cfi: 'cfi-same',
    progressPercent: 10,
    createdAt: 1,
    color: '#fff',
  };
  const first = await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'same',
    operation: 'bookmark.upsert',
    payload: {
      bookmarkId: 'same',
      cfi: 'cfi-same',
      name: 'local',
      color: '#fff',
      progressPercent: 10,
      createdAtClient: 1,
      updatedAtClient: 2,
    },
    localBookmarks: [local],
    deviceId: 'device-1',
    sessionId: 'session-1',
    eventId: 'bookmark-first',
    occurredAtClient: 2,
  });
  const second = await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'same',
    operation: 'bookmark.delete',
    payload: null,
    localBookmarks: [],
    deviceId: 'device-1',
    sessionId: 'session-1',
    eventId: 'bookmark-ignored',
    occurredAtClient: 3,
  });

  const events = await getOutboxEventsV5(ownerA);
  assert.equal(first.coalesced, false);
  assert.equal(second.coalesced, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, 'bookmark-first');
  assert.equal(events[0].operation, 'bookmark.delete');
  assert.equal(events[0].payload, null);
  assert.equal(events[0].baseRevision, 0);
  assert.equal((await getSyncMetaV5(ownerA, 'bookmark:book-1:same')).nextSequence, 2);
});

test('bookmark targets have independent chains and same-id edits are ordered across sessions', async () => {
  const mark = (bookmarkId, eventId, name, occurredAtClient, sessionId = 'session-1') => enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId,
    operation: 'bookmark.upsert',
    payload: {
      bookmarkId,
      cfi: `cfi-${bookmarkId}`,
      name,
      color: '#fff',
      progressPercent: 10,
      createdAtClient: 1,
      updatedAtClient: occurredAtClient,
    },
    localBookmarks: [],
    deviceId: 'device-1',
    sessionId,
    eventId,
    occurredAtClient,
  });
  await mark('a', 'a-1', 'A', 2);
  await mark('b', 'b-1', 'B', 3);
  await mark('a', 'a-2', 'A edited', 4, 'session-2');
  const events = await getOutboxEventsV5(ownerA);
  const aEvents = events.filter(({ targetKey }) => targetKey === 'bookmark:book-1:a');
  const bEvents = events.filter(({ targetKey }) => targetKey === 'bookmark:book-1:b');
  assert.deepEqual(aEvents.map(({ baseRevision }) => baseRevision), [0, 1]);
  assert.deepEqual(aEvents.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(bEvents.map(({ baseRevision }) => baseRevision), [0]);
  assert.deepEqual(bEvents.map(({ sequence }) => sequence), [1]);
});

test('using remote resolves, preserves the local position, and supersedes a conflicting progress chain', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    occurredAtClient: 2,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  await enqueue(ownerA, {
    eventId: 'deferred-latest',
    sessionId: 'session-3',
    position: position(35),
    occurredAtClient: 13,
  });
  const local = await resolveSyncConflictUseRemoteV5(ownerA, 'event-1', 4, true);
  assert.equal(local.progressPercent, 70);
  assert.equal(local.lastRead, remote.occurredAtClient);
  assert.deepEqual(
    local.bookmarks.filter(({ type }) => type === 'auto').map(({ cfi, progressPercent, name }) => ({
      cfi,
      progressPercent,
      name,
    })),
    [{ cfi: position(35).cfi, progressPercent: 35, name: '충돌 전 위치' }],
  );
  assert.deepEqual(
    (await getOutboxEventsV5(ownerA)).map(({ status }) => status),
    ['superseded', 'superseded'],
  );
  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).knownRevision, 1);
  assert.equal(await resolveSyncConflictUseRemoteV5(ownerA, 'event-1', 5, true), null);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 2);
});

test('quiet remote resolution aborts if local reading moved after the policy snapshot', async () => {
  const originalPosition = position(30);
  await enqueue(ownerA, { eventId: 'event-1', position: originalPosition });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  await enqueue(ownerA, {
    eventId: 'deferred-latest',
    sessionId: 'session-2',
    position: position(35),
    occurredAtClient: 13,
  });

  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    14,
    true,
    { kind: 'position', position: originalPosition },
  ), null);
  assert.deepEqual(
    (await getOutboxEventsV5(ownerA)).map(({ status }) => status),
    ['conflict'],
  );
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 35);
});

test('previews active-book remote progress without resolving and finalizes only the same local intent', async () => {
  const originalPosition = position(30);
  await enqueue(ownerA, { eventId: 'event-1', position: originalPosition });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);

  const preview = await previewSyncConflictUseRemoteProgressV5(ownerA, 'event-1', 13, true);
  assert.equal(preview.progress.progressPercent, 70);
  assert.equal(preview.conflict.remoteHead.revision, 1);
  assert.deepEqual(preview.expectedRemoteHead, {
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
  });
  assert.deepEqual(preview.expectedLocalState, {
    kind: 'position',
    position: {
      ...originalPosition,
      anchorCfi: originalPosition.cfi,
    },
  });
  assert.equal((await getOpenSyncConflictsV5(ownerA))[0].state, 'open');
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 30);

  const resolved = await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    13,
    true,
    preview.expectedLocalState,
    preview.expectedRemoteHead,
  );
  assert.equal(resolved.progressPercent, 70);
  assert.equal((await getOpenSyncConflictsV5(ownerA)).length, 0);
});

test('does not finalize an empty progress preview after a new local reading intent', async () => {
  await enqueue(ownerA, {
    eventId: 'reset-event',
    operation: 'progress.reset',
    position: null,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'reset-event', remote, expectedClaim, 12);

  const preview = await previewSyncConflictUseRemoteProgressV5(
    ownerA,
    'reset-event',
    13,
    true,
  );
  assert.deepEqual(preview.expectedLocalState, { kind: 'empty' });

  await enqueue(ownerA, {
    eventId: 'new-reading-intent',
    operation: 'progress.set',
    position: position(35),
    sessionId: 'session-2',
    occurredAtClient: 14,
  });
  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'reset-event',
    15,
    true,
    preview.expectedLocalState,
  ), null);
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 35);
  assert.equal((await getOpenSyncConflictsV5(ownerA))[0].state, 'open');
});

test('does not finalize a stale progress conflict over a newer cached remote head', async () => {
  const originalPosition = position(30);
  await enqueue(ownerA, { eventId: 'event-1', position: originalPosition });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  const preview = await previewSyncConflictUseRemoteProgressV5(ownerA, 'event-1', 13, true);
  const newerRemote = {
    ...remote,
    revision: 2,
    acceptedEventId: 'remote-2',
    position: position(80),
    occurredAtClient: 14,
  };
  await storeRemoteHeadsBatchV5(ownerA, [newerRemote], 14);

  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    15,
    true,
    preview.expectedLocalState,
  ), null);
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 30);
  const [refreshed] = await getOpenSyncConflictsV5(ownerA);
  assert.equal(refreshed.remoteHead.revision, 2);
  assert.equal(refreshed.remoteHead.acceptedEventId, 'remote-2');
});

test('does not finalize a newer refreshed conflict through an older staged head', async () => {
  const originalPosition = position(30);
  await enqueue(ownerA, { eventId: 'event-1', position: originalPosition });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  const preview = await previewSyncConflictUseRemoteProgressV5(ownerA, 'event-1', 13, true);
  await storeRemoteHeadsBatchV5(ownerA, [{
    ...remote,
    revision: 2,
    acceptedEventId: 'remote-2',
    operation: 'reset',
    position: null,
    occurredAtClient: 14,
  }], 14);

  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    15,
    true,
    preview.expectedLocalState,
    preview.expectedRemoteHead,
  ), null);
  const [refreshed] = await getOpenSyncConflictsV5(ownerA);
  assert.equal(refreshed.remoteHead.revision, 2);

  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'event-1',
    16,
    true,
    preview.expectedLocalState,
    preview.expectedRemoteHead,
  ), null);
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 30);
});

test('aborts an in-flight remote conflict transaction when its command is cancelled', async () => {
  const originalPosition = position(30);
  await enqueue(ownerA, { eventId: 'event-1', position: originalPosition });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'remote-1',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  const preview = await previewSyncConflictUseRemoteProgressV5(ownerA, 'event-1', 13, true);
  const controller = new AbortController();
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function abortAfterFirstConflictWrite(...args) {
    const request = originalPut.apply(this, args);
    if (this.name.includes('outbox')) controller.abort();
    return request;
  };
  try {
    assert.equal(await resolveSyncConflictUseRemoteV5(
      ownerA,
      'event-1',
      14,
      true,
      preview.expectedLocalState,
      preview.expectedRemoteHead,
      controller.signal,
    ), null);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
  }
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 30);
  assert.equal((await getOpenSyncConflictsV5(ownerA)).length, 1);
  assert.equal((await getOutboxEventsV5(ownerA))[0].status, 'conflict');
});

test('atomic progress mutation rolls back local progress and every event on failure', async () => {
  const progress = {
    bookId: 'book-1',
    cfi: 'epubcfi(/6/40)',
    anchorCfi: 'epubcfi(/6/40)',
    progressPercent: 40,
    lastRead: 10,
    bookmarks: [],
  };
  const bookmarkEvent = (bookmarkId) => ({
    bookId: 'book-1',
    bookmarkId,
    operation: 'bookmark.delete',
    payload: null,
    localBookmarks: [],
    deviceId: 'device-1',
    sessionId: 'session-1',
    occurredAtClient: 10,
    eventId: 'duplicate-event-id',
  });

  await assert.rejects(enqueueProgressMutationBatchV5(ownerA, {
    progress,
    progressEvent: {
      bookId: 'book-1',
      operation: 'progress.set',
      position: position(40),
      deviceId: 'device-1',
      sessionId: 'session-1',
      occurredAtClient: 10,
      eventId: 'progress-event',
      localBookmarks: [],
    },
    bookmarkEvents: [bookmarkEvent('mark-1'), bookmarkEvent('mark-2')],
  }));
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  assert.equal((await getAllLocalProgressV5(ownerA)).length, 0);
  assert.equal(await getSyncMetaV5(ownerA, 'progress:book-1'), undefined);
});

test('atomic progress mutation commits progress and every bookmark event together', async () => {
  const progress = {
    bookId: 'book-1',
    cfi: '',
    anchorCfi: '',
    progressPercent: 0,
    lastRead: 10,
    bookmarks: [],
  };
  await enqueueProgressMutationBatchV5(ownerA, {
    progress,
    progressEvent: {
      bookId: 'book-1',
      operation: 'progress.reset',
      position: null,
      deviceId: 'device-1',
      sessionId: 'session-1',
      occurredAtClient: 10,
      eventId: 'progress-reset',
      localBookmarks: [],
    },
    bookmarkEvents: ['a', 'b', 'c'].map((bookmarkId) => ({
      bookId: 'book-1',
      bookmarkId,
      operation: 'bookmark.delete',
      payload: null,
      localBookmarks: [],
      deviceId: 'device-1',
      sessionId: 'session-1',
      occurredAtClient: 10,
      eventId: `delete-${bookmarkId}`,
    })),
  });
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(({ eventId }) => eventId).sort(), [
    'delete-a', 'delete-b', 'delete-c', 'progress-reset',
  ]);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 0);
});

test('using a remote bookmark advances its target meta atomically', async () => {
  await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'mark-1',
    operation: 'bookmark.upsert',
    payload: {
      bookmarkId: 'mark-1',
      cfi: 'local-cfi',
      name: 'local',
      color: '#fff',
      progressPercent: 10,
      createdAtClient: 1,
      updatedAtClient: 1,
    },
    localBookmarks: [],
    deviceId: 'device-1',
    sessionId: 'session-1',
    eventId: 'bookmark-local',
    occurredAtClient: 1,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    bookmarkId: 'mark-1',
    revision: 5,
    acceptedEventId: 'bookmark-remote',
    operation: 'upsert',
    bookmark: {
      bookmarkId: 'mark-1',
      cfi: 'remote-cfi',
      name: 'remote',
      color: '#000',
      progressPercent: 50,
      createdAtClient: 2,
      updatedAtClient: 2,
    },
    acceptedDeviceId: 'device-2',
    occurredAtClient: 2,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'bookmark-local', remote, expectedClaim, 12);
  await resolveSyncConflictUseRemoteV5(ownerA, 'bookmark-local', 4);
  assert.equal((await getSyncMetaV5(ownerA, 'bookmark:book-1:mark-1')).knownRevision, 5);
});

test('does not resolve a bookmark conflict with an older cached remote head', async () => {
  await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'mark-1',
    operation: 'bookmark.upsert',
    payload: {
      bookmarkId: 'mark-1',
      cfi: 'local-cfi',
      name: 'local',
      color: '#fff',
      progressPercent: 10,
      createdAtClient: 1,
      updatedAtClient: 1,
    },
    localBookmarks: [],
    deviceId: 'device-1',
    sessionId: 'session-1',
    eventId: 'bookmark-local',
    occurredAtClient: 1,
  });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    bookmarkId: 'mark-1',
    revision: 1,
    acceptedEventId: 'bookmark-remote-1',
    operation: 'delete',
    bookmark: null,
    acceptedDeviceId: 'device-2',
    occurredAtClient: 2,
    updatedAtServer: {},
    deletedAtServer: {},
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'bookmark-local', remote, expectedClaim, 12);
  await storeRemoteHeadsBatchV5(ownerA, [{
    ...remote,
    revision: 2,
    acceptedEventId: 'bookmark-remote-2',
    occurredAtClient: 3,
  }], 13);

  assert.equal(await resolveSyncConflictUseRemoteV5(
    ownerA,
    'bookmark-local',
    14,
  ), null);
  const [refreshed] = await getOpenSyncConflictsV5(ownerA);
  assert.equal(refreshed.remoteHead.revision, 2);
  assert.equal((await getOutboxEventsV5(ownerA))[0].status, 'conflict');
});

test('keeping local creates a new event at the current remote revision', async () => {
  await enqueue(ownerA, { eventId: 'event-1', position: position(30) });
  const remote = {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 2,
    acceptedEventId: 'remote-2',
    operation: 'set',
    position: position(70),
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(ownerA, 'event-1', remote, expectedClaim, 12);
  const replacement = await resolveSyncConflictKeepLocalV5(ownerA, 'event-1', 4);
  assert.equal(replacement.baseRevision, 2);
  assert.equal(replacement.payload.progressPercent, 30);
  assert.equal(replacement.status, 'pending');
  assert.notEqual(replacement.eventId, 'event-1');
  const [keptLocal] = await getAllLocalProgressV5(ownerA);
  assert.equal(keptLocal.progressPercent, 30);
  assert.equal(keptLocal.ignoredRemoteRevision, 2);
  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).knownRevision, 2);
  assert.equal(await resolveSyncConflictKeepLocalV5(ownerA, 'event-1', 5), null);
  await enqueue(ownerA, {
    eventId: 'event-after-resolution',
    sessionId: 'session-after-resolution',
    occurredAtClient: 6,
  });
  const next = (await getOutboxEventsV5(ownerA))
    .find(({ eventId }) => eventId === 'event-after-resolution');
  assert.equal(next.baseRevision, 3);
});

test('restoring a remotely deleted bookmark assigns a new bookmark id', async () => {
  const localBookmark = {
    bookmarkId: 'old-mark',
    cfi: 'cfi-old',
    name: 'old',
    color: '#fff',
    progressPercent: 10,
    createdAtClient: 1,
    updatedAtClient: 2,
  };
  await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'old-mark',
    operation: 'bookmark.upsert',
    payload: localBookmark,
    localBookmarks: [{
      id: localBookmark.bookmarkId,
      type: 'manual',
      name: localBookmark.name,
      cfi: localBookmark.cfi,
      progressPercent: localBookmark.progressPercent,
      createdAt: localBookmark.createdAtClient,
      color: localBookmark.color,
    }],
    deviceId: 'device-1',
    sessionId: 'session-1',
    eventId: 'bookmark-event',
    occurredAtClient: 2,
  });
  const remoteDelete = {
    schemaVersion: 2,
    bookId: 'book-1',
    bookmarkId: 'old-mark',
    revision: 2,
    acceptedEventId: 'remote-delete',
    operation: 'delete',
    bookmark: null,
    acceptedDeviceId: 'other',
    occurredAtClient: 3,
    updatedAtServer: {},
    deletedAtServer: {},
  };
  const { expectedClaim } = await claimNext();
  await recordProgressConflictV5(
    ownerA,
    'bookmark-event',
    remoteDelete,
    expectedClaim,
    12,
  );
  const replacement = await resolveSyncConflictKeepLocalV5(ownerA, 'bookmark-event', 4);
  assert.equal(replacement.target.kind, 'bookmark');
  assert.notEqual(replacement.target.bookmarkId, 'old-mark');
  assert.equal(replacement.payload.bookmarkId, replacement.target.bookmarkId);
  assert.equal(replacement.baseRevision, 0);
});

for (const mode of ['single', 'batch']) {
  const write = (overrides) => {
    const input = {
      bookId: 'book-1', operation: 'progress.set', position: position(10),
      deviceId: 'device-1', sessionId: 'session-1', occurredAtClient: 1, ...overrides,
    };
    return mode === 'single' ? enqueueProgressEventV5(ownerA, input)
      : enqueueProgressMutationBatchV5(ownerA, {
        progress: {
          bookId: input.bookId, cfi: input.position?.cfi ?? '',
          anchorCfi: input.position?.cfi ?? '', progressPercent: input.position?.progressPercent ?? 0,
          lastRead: input.occurredAtClient, bookmarks: [],
        },
        progressEvent: input, bookmarkEvents: [],
      });
  };
  test(`${mode}: set-reset-set preserves the latest local and server position`, async () => {
    await write({ eventId: 'set-1' });
    await write({ eventId: 'reset-2', operation: 'progress.reset', position: null, occurredAtClient: 2 });
    await write({ eventId: 'set-3', position: position(30), occurredAtClient: 3 });
    const events = await getOutboxEventsV5(ownerA);
    assert.deepEqual(events.map(({ operation }) => operation), ['progress.set', 'progress.reset', 'progress.set']);
    assert.deepEqual(events.map(({ baseRevision }) => baseRevision), [0, 1, 2]);
    const { decideProgressTransaction } = await import('../src/lib/progressSyncTransaction.ts');
    let storedHead;
    for (const event of events) {
      const decision = decideProgressTransaction({ event, storedHead, storedReceipt: undefined, serverTime: {} });
      assert.equal(decision.status, 'apply');
      storedHead = decision.head;
    }
    assert.equal(storedHead.position.progressPercent, 30);
    assert.equal((await getAllLocalProgressV5(ownerA))[0].progressPercent, 30);
  });
  test(`${mode}: another session forms a coalescing boundary`, async () => {
    await write({ eventId: 'session-a-1' });
    await write({ eventId: 'session-b-2', sessionId: 'session-2', occurredAtClient: 2 });
    await write({ eventId: 'session-a-3', position: position(30), occurredAtClient: 3 });
    const events = await getOutboxEventsV5(ownerA);
    assert.deepEqual(events.map(({ eventId }) => eventId), ['session-a-1', 'session-b-2', 'session-a-3']);
    assert.equal(events[0].payload.progressPercent, 10);
  });
  for (const retry of [false, true]) {
    test(`${mode}: ${retry ? 'retried' : 'claimed'} events retain their submitted payload`, async () => {
      await write({ eventId: 'submitted' });
      const claim = await claimNext(10);
      if (retry) await scheduleProgressEventRetryV5(ownerA, 'submitted', 'unavailable', claim.expectedClaim, 12, 0);
      await write({ eventId: 'new-intent', position: position(30), occurredAtClient: 13 });
      const events = await getOutboxEventsV5(ownerA);
      assert.equal(events.length, 2);
      assert.equal(events[0].payload.progressPercent, 10);
      assert.equal(events[1].payload.progressPercent, 30);
    });
  }
}

const ackHead = (eventId = 'ack-1', revision = 1) => ({
  schemaVersion: 2, bookId: 'book-1', revision, acceptedEventId: eventId,
  operation: 'set', position: position(revision * 10), acceptedDeviceId: 'device-1',
  acceptedSessionId: 'session-1', occurredAtClient: revision, updatedAtServer: {}, deletedAtServer: null,
});

test('r2 snapshot then r1 ACK preserves r2 cache and allows its adoption', async () => {
  await enqueue(ownerA, { eventId: 'ack-1' });
  const claim = await claimNext(10);
  const newer = ackHead('remote-2', 2);
  await storeRemoteHeadsBatchV5(ownerA, [newer], 12);
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'ack-1', ackHead(), claim.expectedClaim, 13), true);
  const { initDB } = await import('../src/lib/localDB.ts');
  const db = await initDB();
  assert.equal((await db.get('remote-heads-v5', [ownerA, 'progress:book-1'])).revision, 2);
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'ack-1', ackHead(), claim.expectedClaim, 14), false);
  assert.equal((await adoptRemoteProgressLocallyV5(ownerA, {
    operation: 'set', bookId: 'book-1', cfi: newer.position.cfi, anchorCfi: newer.position.cfi,
    progressPercent: 20, lastRead: 2, syncRevision: 2, acceptedEventId: 'remote-2',
  })).status, 'adopted');
});

test('ACK does not lower an already adopted local revision and rejects equal-revision identity mismatch atomically', async () => {
  await enqueue(ownerA, { eventId: 'ack-1' });
  const claim = await claimNext(10);
  const { initDB } = await import('../src/lib/localDB.ts');
  const db = await initDB();
  const [progress] = await getAllLocalProgressV5(ownerA);
  await db.put('progress-v5', { ...progress, ownerKey: ownerA, syncRevision: 2, acceptedEventId: 'remote-2' });
  await storeRemoteHeadsBatchV5(ownerA, [ackHead('other-event', 1)]);
  await assert.rejects(acknowledgeProgressEventV5(ownerA, 'ack-1', ackHead(), claim.expectedClaim), { code: 'invalid-argument' });
  assert.equal((await getOutboxEventsV5(ownerA)).length, 1);
  await storeRemoteHeadsBatchV5(ownerA, [ackHead('remote-2', 2)]);
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'ack-1', ackHead(), claim.expectedClaim), true);
  assert.equal((await getAllLocalProgressV5(ownerA))[0].syncRevision, 2);
  assert.equal((await getAllLocalProgressV5(ownerA))[0].acceptedEventId, 'remote-2');
});

test('palette ACK uses the same monotone cache policy as progress', async () => {
  const { enqueueAnnotationPaletteEventV5 } = await import('../src/lib/syncOutboxV5.ts');
  const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');
  await enqueueAnnotationPaletteEventV5(ownerA, {
    eventId: 'palette-ack', payload: { items: DEFAULT_ANNOTATION_PALETTE }, occurredAtClient: 1,
  }, { deviceId: 'device-1', sessionId: 'session-1' });
  const claim = await claimNext(10);
  const head = {
    schemaVersion: 1, revision: 1, acceptedEventId: 'palette-ack', operation: 'set',
    palette: { items: DEFAULT_ANNOTATION_PALETTE }, acceptedDeviceId: 'device-1',
    acceptedSessionId: 'session-1', occurredAtClient: 1, updatedAtServer: {},
  };
  await storeRemoteHeadsBatchV5(ownerA, [{ ...head, revision: 2, acceptedEventId: 'palette-remote-2' }]);
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'palette-ack', head, claim.expectedClaim), true);
  const { initDB } = await import('../src/lib/localDB.ts');
  const db = await initDB();
  assert.equal((await db.get('remote-heads-v5', [ownerA, claim.event.targetKey])).revision, 2);
});

test('ACK first then older and duplicate snapshots retain the acknowledged head', async () => {
  await enqueue(ownerA, { eventId: 'ack-2' });
  const claim = await claimNext(10);
  const head = ackHead('ack-2', 2);
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'ack-2', head, claim.expectedClaim), true);
  await storeRemoteHeadsBatchV5(ownerA, [ackHead('older-1', 1)]);
  await storeRemoteHeadsBatchV5(ownerA, [head]);
  const { initDB } = await import('../src/lib/localDB.ts');
  const db = await initDB();
  const cached = await db.get('remote-heads-v5', [ownerA, 'progress:book-1']);
  assert.equal(cached.revision, 2);
  assert.equal(cached.head.acceptedEventId, 'ack-2');
  assert.equal((await getAllLocalProgressV5(ownerA))[0].syncRevision, 2);
});
