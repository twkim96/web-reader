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
  getOutboxEventsV5,
  getPausedSyncSummaryV5,
  getRetryDelayMs,
  getSyncMetaV5,
  recoverExpiredInFlightEventsV5,
  releaseSyncLeaseV5,
  recordProgressConflictV5,
  pauseProgressEventV5,
  resumePausedAuthEventsV5,
  resolveSyncConflictKeepLocalV5,
  resolveSyncConflictUseRemoteV5,
  scheduleProgressEventRetryV5,
  storeRemoteProgressHeadV5,
} = await import('../src/lib/syncOutboxV5.ts');
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
  assert.equal(await adoptRemoteProgressLocallyV5(ownerA, {
    bookId: 'book-1',
    cfi: remote.position.cfi,
    anchorCfi: remote.position.cfi,
    progressPercent: 70,
    lastRead: 10,
    syncRevision: 7,
    acceptedEventId: 'remote-7',
  }), true);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  const { getAllLocalProgressV5 } = await import('../src/lib/localDBV5.ts');
  const [saved] = await getAllLocalProgressV5(ownerA);
  assert.equal(saved.progressPercent, 70);
  assert.equal(saved.syncRevision, 7);
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

  assert.equal(await adoptRemoteProgressLocallyV5(ownerA, {
    bookId: 'book-1',
    cfi: remote.position.cfi,
    anchorCfi: remote.position.cfi,
    progressPercent: 70,
    lastRead: 10,
    syncRevision: 7,
    acceptedEventId: 'remote-7',
  }), false);
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
  await enqueue(ownerA, { eventId: 'event-1' });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
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

test('bookmark targets have independent chains and same-id edits are ordered', async () => {
  const mark = (bookmarkId, eventId, name, occurredAtClient) => enqueueBookmarkEventV5(ownerA, {
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
    sessionId: 'session-1',
    eventId,
    occurredAtClient,
  });
  await mark('a', 'a-1', 'A', 2);
  await mark('b', 'b-1', 'B', 3);
  await mark('a', 'a-2', 'A edited', 4);
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
});

test('restoring a remotely deleted bookmark assigns a new bookmark id', async () => {
  await enqueueBookmarkEventV5(ownerA, {
    bookId: 'book-1',
    bookmarkId: 'old-mark',
    operation: 'bookmark.upsert',
    payload: {
      bookmarkId: 'old-mark',
      cfi: 'cfi-old',
      name: 'old',
      color: '#fff',
      progressPercent: 10,
      createdAtClient: 1,
      updatedAtClient: 2,
    },
    localBookmarks: [],
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
