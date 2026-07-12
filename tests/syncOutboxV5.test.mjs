import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  acknowledgeProgressEventV5,
  acquireSyncLeaseV5,
  claimNextProgressEventV5,
  enqueueProgressEventV5,
  getOutboxEventsV5,
  getRetryDelayMs,
  getSyncMetaV5,
  recoverExpiredInFlightEventsV5,
  recordProgressConflictV5,
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

test('conflict preserves the event and blocks its later chain', async () => {
  await enqueue(ownerA, { eventId: 'event-1' });
  await enqueue(ownerA, {
    eventId: 'event-2',
    sessionId: 'session-2',
    occurredAtClient: 2,
  });
  const conflict = await recordProgressConflictV5(ownerA, 'event-1', null, 3);
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
    revision: 1,
    acceptedEventId: 'event-1',
    operation: 'set',
    position: position(10),
    acceptedDeviceId: 'device-1',
    occurredAtClient: 1,
    updatedAtServer: {},
    deletedAtServer: null,
  };
  assert.equal(await acknowledgeProgressEventV5(ownerA, 'event-1', head, 2), true);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  assert.equal((await getSyncMetaV5(ownerA, 'progress:book-1')).knownRevision, 1);
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

test('retry delay uses bounded exponential backoff with jitter', () => {
  assert.equal(getRetryDelayMs(1, 0), 1_000);
  assert.equal(getRetryDelayMs(2, 0.5), 2_200);
  assert.equal(getRetryDelayMs(20, 1), 60_000);
});
