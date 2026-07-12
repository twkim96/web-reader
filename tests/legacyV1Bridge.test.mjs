import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME } = await import('../src/lib/localDBSchema.ts');
const {
  claimLegacyV1CandidateV5,
  fingerprintLegacyV1Document,
} = await import('../src/lib/legacyV1Bridge.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const owner = makeOwnerKey(makeFirebaseOwnerKey('a'), 'library:local');

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

test('fingerprint is stable across object key order', () => {
  assert.equal(
    fingerprintLegacyV1Document('book', { cfi: 'a', progressPercent: 10 }),
    fingerprintLegacyV1Document('book', { progressPercent: 10, cfi: 'a' }),
  );
});

test('surfaces one server-confirmed legacy value once and changed values again', async () => {
  const first = fingerprintLegacyV1Document('book', { cfi: 'a' });
  const changed = fingerprintLegacyV1Document('book', { cfi: 'b' });
  assert.equal(await claimLegacyV1CandidateV5(owner, 'book', first, 1), true);
  assert.equal(await claimLegacyV1CandidateV5(owner, 'book', first, 2), false);
  assert.equal(await claimLegacyV1CandidateV5(owner, 'book', changed, 3), true);
});
