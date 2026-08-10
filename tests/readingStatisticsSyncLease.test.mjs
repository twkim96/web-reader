import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  acquireReadingStatisticsSyncLeaseV13,
  getReadingStatisticsSyncLeaseV13,
  isReadingStatisticsSyncLeaseCurrentV13,
  ReadingStatisticsSyncLeaseRuntime,
  releaseReadingStatisticsSyncLeaseV13,
} = await import('../src/lib/readingStatisticsSyncLease.ts');
const {
  makeFirebaseOwnerKey,
  makeOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('stats-a'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('stats-b'), 'library:local');

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

test('elects one statistics leader per owner and renews the same live epoch', async () => {
  const [tabA, tabB] = await Promise.all([
    acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-a', 100, 50),
    acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', 100, 50),
  ]);
  const winner = tabA ?? tabB;
  const loserTabId = tabA ? 'tab-b' : 'tab-a';
  assert.ok(winner);
  assert.equal(Number(Boolean(tabA)) + Number(Boolean(tabB)), 1);
  assert.equal(await acquireReadingStatisticsSyncLeaseV13(
    ownerA,
    winner.holderTabId,
    120,
    50,
  ).then((lease) => lease.epoch), 1);
  assert.equal(await acquireReadingStatisticsSyncLeaseV13(
    ownerA,
    loserTabId,
    121,
    50,
  ), null);
  assert.equal((await acquireReadingStatisticsSyncLeaseV13(
    ownerB,
    loserTabId,
    121,
    50,
  )).epoch, 1);
});

test('fails over after expiry and rejects every late continuation from the old epoch', async () => {
  const first = await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-a', 100, 50);
  const second = await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', 151, 50);
  assert.equal(first.epoch, 1);
  assert.equal(second.epoch, 2);
  assert.equal(await isReadingStatisticsSyncLeaseCurrentV13(
    ownerA,
    'tab-a',
    first.epoch,
    152,
  ), false);
  assert.equal(await isReadingStatisticsSyncLeaseCurrentV13(
    ownerA,
    'tab-b',
    second.epoch,
    152,
  ), true);

  await releaseReadingStatisticsSyncLeaseV13(ownerA, 'tab-a', first.epoch, 153);
  assert.equal((await getReadingStatisticsSyncLeaseV13(ownerA)).holderTabId, 'tab-b');
});

test('release lets a follower take over immediately and same tab reacquire gets a new epoch', async () => {
  const first = await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-a', 100, 50);
  await releaseReadingStatisticsSyncLeaseV13(ownerA, 'tab-a', first.epoch, 110);
  const follower = await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', 111, 50);
  assert.equal(follower.epoch, 2);
  await releaseReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', follower.epoch, 112);
  const reacquired = await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', 113, 50);
  assert.equal(reacquired.epoch, 3);
});

test('runtime invalidates its generation across forced takeover and owner-scoped release', async () => {
  const runtime = new ReadingStatisticsSyncLeaseRuntime(ownerA, 'tab-a');
  assert.equal((await runtime.acquire(100)).epoch, 1);
  assert.equal(runtime.epoch, 1);
  assert.equal(await runtime.isCurrent(120), true);

  await acquireReadingStatisticsSyncLeaseV13(ownerA, 'tab-b', 15_101, 50);
  assert.equal(await runtime.isCurrent(15_102), false);
  await runtime.release(15_103);
  assert.equal(runtime.epoch, null);
  assert.equal((await getReadingStatisticsSyncLeaseV13(ownerA)).holderTabId, 'tab-b');
});

test('late acquire cannot revive a released runtime or expire its newer lifecycle', async () => {
  let resolveFirstAcquire;
  let acquireCount = 0;
  const releases = [];
  const runtime = new ReadingStatisticsSyncLeaseRuntime(ownerA, 'tab-a', {
    acquire: async (ownerKey, holderTabId, now) => {
      acquireCount += 1;
      if (acquireCount === 1) {
        return new Promise((resolve) => {
          resolveFirstAcquire = () => resolve({
            ownerKey,
            holderTabId,
            epoch: 1,
            heartbeatAt: now,
            expiresAt: now + 1_000,
          });
        });
      }
      return {
        ownerKey,
        holderTabId,
        epoch: 2,
        heartbeatAt: now,
        expiresAt: now + 1_000,
      };
    },
    release: async (...args) => {
      releases.push(args);
    },
  });

  const staleAcquire = runtime.acquire(100);
  await runtime.release(101);
  const current = await runtime.acquire(102);
  resolveFirstAcquire();

  assert.equal((await staleAcquire), null);
  assert.equal(current.epoch, 2);
  assert.deepEqual(runtime.claim, {
    holderTabId: 'tab-a:1',
    epoch: 2,
  });
  assert.equal(releases.length, 1);
  assert.equal(releases[0][1], 'tab-a:0');
  assert.equal(releases[0][2], 1);
});
