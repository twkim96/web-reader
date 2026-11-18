import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const { closeLocalDB, initDB } = await import('../src/lib/localDB.ts');
const { LOCAL_DB_NAME, V5_OUTBOX_STORE } = await import('../src/lib/localDBSchema.ts');
const { ownerRuntime } = await import('../src/lib/ownerRuntime.ts');
const { createSyncEventId, prepareWriteLease, requestReceiptMaintenance } = await import('../src/lib/writeLeaseTransport.ts');
const { createLeasedEventId, parseLeasedEventId, WRITE_LEASE_DURATION_MS } = await import('../src/lib/writeLeasePolicy.ts');
const { enqueueProgressEventV5, getOutboxEventsV5 } = await import('../src/lib/syncOutboxV5.ts');
const { decideProgressTransaction } = await import('../src/lib/progressSyncTransaction.ts');
const { ProgressSyncWorker } = await import('../src/lib/progressSyncWorker.ts');
const { recoverExpiredProgressFromServer } = await import('../src/lib/expiredSyncRecovery.ts');

const ownerKey = 'firebase:lease-flow|library:local';
const initial = Date.now();
let now = initial;
const lease = { leaseId: crypto.randomUUID(), deviceId: 'device', issuedAtMillis: initial };
const originalClock = Date.now;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
const cache = new Map();

test.before(async () => {
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  Date.now = () => now;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value),
  } });
  cache.set(`sync_write_lease_v1:${ownerKey}`, JSON.stringify(lease));
  await closeLocalDB();
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(LOCAL_DB_NAME); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
});
test.after(async () => {
  ownerRuntime.clear(); await closeLocalDB();
  Date.now = originalClock;
  if (originalFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = originalFlag;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

const input = bookId => ({ bookId, deviceId: 'device', sessionId: 'session', operation: 'progress.set',
  position: { cfi: 'local', anchorCfi: null, progressPercent: 20 }, occurredAtClient: now });

test('cached server lease binds enqueue and the real worker ACK without changing event identity', async () => {
  const { event } = await enqueueProgressEventV5(ownerKey, input('accepted'));
  assert.equal(parseLeasedEventId(event.eventId).leaseId, lease.leaseId);
  const owner = ownerRuntime.activate(ownerKey);
  let appliedId;
  const worker = new ProgressSyncWorker(owner, 'tab', async event => {
    appliedId = event.eventId;
    return decideProgressTransaction({ event, storedHead: undefined, storedReceipt: undefined, serverTime: {} });
  }, { now: () => now });
  try {
    assert.equal(await worker.flushOne(now), 'apply');
    assert.equal(appliedId, event.eventId);
    assert.equal((await getOutboxEventsV5(ownerKey)).length, 0);
    assert.equal((await (await initDB()).get('progress-v5', [ownerKey, 'accepted'])).acceptedEventId, event.eventId);
  } finally { await worker.dispose(); }
});

test('expired event is quarantined before fresh canonical recovery with authoritative time', async () => {
  const originalId = createLeasedEventId(lease);
  await enqueueProgressEventV5(ownerKey, { ...input('expired'), eventId: originalId });
  now += WRITE_LEASE_DURATION_MS;
  const db = await initDB();
  const original = await db.get(V5_OUTBOX_STORE, [ownerKey, originalId]);
  const head = { schemaVersion: 2, bookId: 'expired', revision: 4, acceptedEventId: 'other', operation: 'set',
    position: { cfi: 'latest-server', anchorCfi: null, progressPercent: 80 }, acceptedDeviceId: 'other-device',
    occurredAtClient: now, updatedAtServer: {}, deletedAtServer: null };
  {
    const result = await recoverExpiredProgressFromServer('lease-flow', ownerKey, 'expired', { serverTrustedNow: now, fetchHead: async () => head });
    assert.equal(result.status, 'resynced');
    const saved = await db.get(V5_OUTBOX_STORE, [ownerKey, originalId]);
    assert.equal(saved.status, 'expired'); assert.equal(saved.recoveryPending, false);
    assert.equal(saved.eventId, originalId); assert.deepEqual(saved.payload, original.payload);
    assert.equal((await db.get('progress-v5', [ownerKey, 'expired'])).cfi, 'latest-server');
    assert.equal((await getOutboxEventsV5(ownerKey)).length, 1);
  }
});

test('first-online placeholders bind once with server time despite skew, while old identities remain immutable', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const path = require.resolve('firebase/firestore');
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    let issued = 1700000000000;
    let mono = 100;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => mono } });
    require.cache[path] = { id: path, filename: path, loaded: true, exports: {
      doc: () => ({}), serverTimestamp: () => ({}), setDoc: async () => { await wait; },
      getDocFromServer: async () => ({ exists: () => true, metadata: { hasPendingWrites: false },
        data: () => ({ schemaVersion: 1, deviceId: 'device', issuedAtServer: { toMillis: () => issued } }) }),
    } };
    process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
    const transport = (await import('./src/lib/writeLeaseTransport.ts')).default;
    const policy = (await import('./src/lib/writeLeasePolicy.ts')).default;
    await import('fake-indexeddb/auto');
    const localDB = (await import('./src/lib/localDB.ts')).default;
    const schema = (await import('./src/lib/localDBSchema.ts')).default;
    const outbox = (await import('./src/lib/syncOutboxV5.ts')).default;
    const recovery = (await import('./src/lib/expiredSyncRecovery.ts')).default;
    const deletion = (await import('./src/lib/annotationBookDeletion.ts')).default;
    const owner = 'firebase:online|library:local';
    Date.now = () => issued - 2000;
    const before = transport.createSyncEventId(owner, 'device');
    const attempted = transport.createSyncEventId(owner, 'device');
    const freshIntent = transport.createSyncEventId(owner, 'device');
    const attemptedIntent = transport.createSyncEventId(owner, 'device');
    const claimedIntent = transport.createSyncEventId(owner, 'device');
    const reloaded = 'unleased_reloaded';
    const db = await localDB.initDB();
    const row = (eventId, attempts, sequence) => ({ ownerKey: owner, eventId, target: { kind: 'progress', bookId: String(sequence) },
      targetKey: 'progress:' + sequence, operation: 'progress.set', payload: { cfi: 'local', anchorCfi: null, progressPercent: 20 },
      deviceId: 'device', sessionId: 's', sequence, baseRevision: 0, occurredAtClient: issued,
      status: 'pending', attempts, nextAttemptAt: null, lastErrorCode: null, claimedByTabId: null, claimedLeaseEpoch: null, claimToken: null });
    await db.put(schema.V5_OUTBOX_STORE, row(before, 0, 1));
    await db.put(schema.V5_OUTBOX_STORE, row(attempted, 1, 2));
    await db.put(schema.V5_OUTBOX_STORE, row(reloaded, 0, 3));
    for (const [bookId, writeLeaseEventId] of [['fresh-book', freshIntent], ['attempted-book', attemptedIntent], ['claimed-book', claimedIntent]]) {
      await db.put(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, { ownerKey: owner, bookId, createdAt: issued,
        lastCheckedAt: null, writeLeaseEventId, writeLeaseDeviceId: 'device' });
    }
    await db.put(schema.V5_OUTBOX_STORE, { ...row(transport.createSyncEventId(owner, 'device'), 1, 4), target: { kind: 'annotation', bookId: 'attempted-book', annotationId: 'note' }, targetKey: 'annotation:attempted-book:note' });
    await db.put(schema.V5_OUTBOX_STORE, { ...row(transport.createSyncEventId(owner, 'device'), 0, 5), target: { kind: 'annotation', bookId: 'claimed-book', annotationId: 'note' }, targetKey: 'annotation:claimed-book:note', claimToken: 'claim' });
    for (const [bookId, fields] of [['legacy-book', {}], ['restored-book', { writeLeaseEventId: 'unleased_restored', writeLeaseDeviceId: 'device' }]]) {
      await db.put(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, { ownerKey: owner, bookId, createdAt: issued, lastCheckedAt: null, ...fields });
    }
    let deletionFetches = 0;
    await deletion.reconcileAnnotationBookDeletionIntentsV10('online', owner, { deviceId: 'device', sessionId: 's' }, issued,
      async () => { deletionFetches++; return []; });
    assert.equal(deletionFetches, 0);
    const prep = transport.prepareWriteLease({}, 'online', owner, 'device');
    const during = transport.createSyncEventId(owner, 'device');
    assert.match(before, /^unleased_/); assert.match(during, /^unleased_/);
    assert.equal(transport.resolvePendingSyncEventId(owner, before, 'device'), null);
    release(); await prep;
    assert.equal(transport.getTrustedWriteLeaseTime(owner), issued);
    assert.equal(await outbox.bindPendingSyncAuthorityV5(owner), 1);
    assert.equal(await db.get(schema.V5_OUTBOX_STORE, [owner, before]), undefined);
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, attempted])).attempts, 1);
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, reloaded])).eventId, reloaded);
    const readIntent = bookId => db.get(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, [owner, bookId]);
    assert.ok(policy.parseLeasedEventId((await readIntent('fresh-book')).writeLeaseEventId));
    assert.equal((await readIntent('attempted-book')).writeLeaseEventId, attemptedIntent);
    assert.equal((await readIntent('claimed-book')).writeLeaseEventId, claimedIntent);
    // A fresh server lease must not hide restored intents behind the reconcile timer.
    await deletion.reconcileAnnotationBookDeletionIntentsV10('online', owner, { deviceId: 'device', sessionId: 's' }, issued + 1,
      async () => { deletionFetches++; return []; });
    assert.equal(deletionFetches, 0);
    const targets = await recovery.listExpiredSyncRecoveryTargets(owner, transport.getTrustedWriteLeaseTime(owner));
    assert.ok(targets.some(target => target.bookId === 'legacy-book'));
    assert.ok(targets.some(target => target.bookId === 'restored-book'));
    assert.equal(targets.some(target => target.bookId === 'fresh-book'), false);
    for (const bookId of ['legacy-book', 'restored-book']) {
      assert.deepEqual(await recovery.recoverExpiredSyncTargetFromServer('online', owner,
        { kind: 'annotation', bookId, annotationId: 'book_delete_marker_v1' }, {
          serverTrustedNow: transport.getTrustedWriteLeaseTime(owner),
          fetchAnnotationBook: async () => ({ heads: [], marker: null, targetHead: null }),
        }), { status: 'resynced' });
      assert.equal((await readIntent(bookId)).recoveryPending, false);
      assert.equal((await readIntent(bookId)).writeLeaseEventId, bookId === 'legacy-book' ? undefined : 'unleased_restored');
    }
    await db.put(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, { ownerKey: owner, bookId: 'legacy-reconcile', createdAt: issued, lastCheckedAt: null });
    const beforeReconcile = await db.getAll(schema.V5_OUTBOX_STORE);
    const fetchedBooks = [];
    await deletion.reconcileAnnotationBookDeletionIntentsV10('online', owner, { deviceId: 'device', sessionId: 's' }, issued + 6000,
      async (_uid, bookId) => { fetchedBooks.push(bookId); return []; });
    assert.equal((await readIntent('legacy-reconcile')).expired, true);
    assert.equal((await readIntent('legacy-reconcile')).recoveryPending, true);
    assert.equal(fetchedBooks.includes('legacy-reconcile'), false);
    assert.equal((await readIntent('attempted-book')).expired, true);
    assert.equal((await readIntent('claimed-book')).expired, true);
    assert.deepEqual(await db.getAll(schema.V5_OUTBOX_STORE), beforeReconcile);
    for (const id of [before, during]) {
      const bound = transport.resolvePendingSyncEventId(owner, id, 'device');
      assert.ok(policy.parseLeasedEventId(bound));
      assert.equal(transport.resolvePendingSyncEventId(owner, id, 'device'), bound);
      assert.equal(transport.resolvePendingSyncEventId(owner, id, 'other'), null);
    }
    assert.equal(transport.resolvePendingSyncEventId(owner, 'unleased_reloaded', 'device'), null);
    const leased = transport.createSyncEventId(owner, 'device');
    assert.equal(transport.resolvePendingSyncEventId(owner, leased, 'device'), null);
    // Resolving a valid old conflict must not borrow the freshly cached lease.
    const oldLease = { leaseId: crypto.randomUUID(), deviceId: 'device', issuedAtMillis: issued - policy.WRITE_LEASE_DURATION_MS + 864e5 };
    const originalConflictId = policy.createLeasedEventId(oldLease);
    const conflictEvent = { ...row(originalConflictId, 1, 17), status: 'conflict' };
    await db.put(schema.V5_OUTBOX_STORE, conflictEvent);
    await db.put(schema.V5_PROGRESS_STORE, { ownerKey: owner, bookId: '17', cfi: 'kept-local', progressPercent: 20, lastRead: issued, bookmarks: [] });
    await db.put(schema.V5_SYNC_CONFLICTS_STORE, { ownerKey: owner, conflictId: originalConflictId,
      targetKey: conflictEvent.targetKey, state: 'open', event: conflictEvent,
      remoteHead: null, latestLocalPosition: conflictEvent.payload, blockedEventIds: [], createdAt: issued });
    const replacement = await outbox.resolveSyncConflictKeepLocalV5(owner, originalConflictId, issued);
    assert.ok(replacement);
    assert.notEqual(replacement.eventId, originalConflictId);
    assert.equal(policy.parseLeasedEventId(replacement.eventId).leaseId, oldLease.leaseId);
    assert.equal(policy.parseLeasedEventId(replacement.eventId).issuedAtMillis, oldLease.issuedAtMillis);
    assert.equal(replacement.baseRevision, 0);
    assert.equal(replacement.payload.cfi, 'kept-local');
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, originalConflictId])).status, 'superseded');
    Date.now = () => issued + 2000;
    transport.assertEventWriteLease(leased, owner);
    mono += policy.WRITE_LEASE_DURATION_MS;
    assert.throws(() => transport.assertEventWriteLease(leased, owner), { code: 'sync/write-lease-expired' });
    const transaction = (await import('./src/lib/progressSyncTransaction.ts')).default;
    assert.throws(() => transaction.decideProgressTransaction({ event: { eventId: leased, ownerKey: owner }, storedReceipt: {}, storedHead: {}, serverTime: {} }), { code: 'sync/write-lease-expired' });
    assert.throws(() => transport.assertEventWriteLease('unleased_reloaded', owner), { code: 'sync/write-lease-pending' });
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('lease creation refuses mismatched account and empty device before any Firestore access', async () => {
  await assert.rejects(prepareWriteLease(null, 'other-user', ownerKey, 'device'), /계정/);
  await assert.rejects(prepareWriteLease(null, 'lease-flow', ownerKey, ''), /기기/);
  now = initial;
  assert.match(createSyncEventId(ownerKey, 'different-device'), /^unleased_/);
});

test('maintenance retries a network failure and throttles a successful request for one day', async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; if (calls === 1) throw new Error('offline'); return { ok: true, status: 200 }; };
    now = initial;
    await assert.rejects(requestReceiptMaintenance('maintenance-test', async () => 'token'), /offline/);
    await requestReceiptMaintenance('maintenance-test', async () => 'token');
    await requestReceiptMaintenance('maintenance-test', async () => 'token');
    assert.equal(calls, 2);
    now += 864e5;
    await requestReceiptMaintenance('maintenance-test', async () => 'token');
    assert.equal(calls, 3);
  } finally { globalThis.fetch = oldFetch; now = initial; }
});
