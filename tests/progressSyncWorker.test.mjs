import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const { ProgressSyncWorker } = await import('../src/lib/progressSyncWorker.ts');
const {
  enqueueProgressEventV5,
  getOutboxEventsV5,
} = await import('../src/lib/syncOutboxV5.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('a'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('b'), 'library:local');
const position = { cfi: 'cfi', anchorCfi: null, progressPercent: 10 };

const resetDatabase = async () => {
  ownerRuntime.clear();
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

const seed = () => enqueueProgressEventV5(ownerA, {
  bookId: 'book-1',
  operation: 'progress.set',
  position,
  deviceId: 'device-1',
  sessionId: 'session-1',
  eventId: 'event-1',
  occurredAtClient: 1,
});

const applied = {
  status: 'apply',
  head: {
    schemaVersion: 2,
    bookId: 'book-1',
    revision: 1,
    acceptedEventId: 'event-1',
    operation: 'set',
    position,
    acceptedDeviceId: 'device-1',
    occurredAtClient: 1,
    updatedAtServer: {},
    deletedAtServer: null,
  },
  receipt: {
    schemaVersion: 2,
    eventId: 'event-1',
    targetKind: 'progress',
    bookId: 'book-1',
    bookmarkId: null,
    targetKey: 'progress:book-1',
    revision: 1,
    createdAtServer: {},
  },
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('leader applies and acknowledges one event', async () => {
  await seed();
  const owner = ownerRuntime.activate(ownerA);
  const worker = new ProgressSyncWorker(owner, 'tab-a', async () => applied);
  assert.equal(await worker.flushOne(10), 'apply');
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
  await worker.dispose();
});

test('local ack failure retries and receipt replay avoids duplicate apply', async () => {
  await seed();
  const owner = ownerRuntime.activate(ownerA);
  let remoteCalls = 0;
  let ackCalls = 0;
  const worker = new ProgressSyncWorker(
    owner,
    'tab-a',
    async () => {
      remoteCalls += 1;
      return remoteCalls === 1 ? applied : { ...applied, status: 'already_applied' };
    },
    {
      async acknowledge(...args) {
        ackCalls += 1;
        if (ackCalls === 1) throw Object.assign(new Error('idb failed'), { code: 'unavailable' });
        const { acknowledgeProgressEventV5 } = await import('../src/lib/syncOutboxV5.ts');
        return acknowledgeProgressEventV5(...args);
      },
    },
  );
  assert.equal(await worker.flushOne(10), 'retry_scheduled');
  assert.equal(await worker.flushOne(2_000), 'already_applied');
  assert.equal(remoteCalls, 2);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 0);
});

test('late response after owner switch cannot acknowledge the old owner', async () => {
  await seed();
  const owner = ownerRuntime.activate(ownerA);
  const worker = new ProgressSyncWorker(owner, 'tab-a', async () => {
    ownerRuntime.activate(ownerB);
    return applied;
  });
  assert.equal(await worker.flushOne(10), 'stale_owner');
  assert.equal((await getOutboxEventsV5(ownerA))[0].status, 'in_flight');
});

test('a second tab cannot claim while the first lease is live', async () => {
  await seed();
  const owner = ownerRuntime.activate(ownerA);
  const first = new ProgressSyncWorker(owner, 'tab-a', async () => applied);
  const second = new ProgressSyncWorker(owner, 'tab-b', async () => applied);
  assert.equal(await first.flushOne(10), 'apply');
  await seed();
  assert.equal(await second.flushOne(11), 'not_leader');
});
