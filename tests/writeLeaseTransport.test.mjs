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
    const held = new Map();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (name, options, callback) => {
        if (held.has(name)) return callback(null);
        const lock = { name, mode: 'exclusive' };
        const end = Promise.withResolvers();
        held.set(name, end.resolve);
        try { return await Promise.race([callback(lock), end.promise]); }
        finally { held.delete(name); }
      },
      query: async () => ({ held: [...held.keys()].map(name => ({ name })) }),
    } });
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
    await transport.prepareSyncEventWriter(owner, 'device');
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
        lastCheckedAt: null, markerEventId: writeLeaseEventId, writeLeaseEventId, writeLeaseDeviceId: 'device' });
    }
    const markerRow = (eventId, bookId, attempts, claimToken = null) => ({ ...row(eventId, attempts, 1),
      target: { kind: 'annotation', bookId, annotationId: 'book_delete_marker_v1' },
      targetKey: 'annotation:' + bookId + ':book_delete_marker_v1', operation: 'annotation.delete', payload: null, claimToken });
    await db.put(schema.V5_OUTBOX_STORE, markerRow(freshIntent, 'fresh-book', 0));
    await db.put(schema.V5_OUTBOX_STORE, markerRow(attemptedIntent, 'attempted-book', 1));
    await db.put(schema.V5_OUTBOX_STORE, markerRow(claimedIntent, 'claimed-book', 0, 'claim'));
    for (const [bookId, fields] of [['legacy-book', {}], ['restored-book', {
      markerEventId: 'unleased_restored', writeLeaseEventId: 'unleased_restored', writeLeaseDeviceId: 'device' }]]) {
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
    assert.equal(await outbox.bindPendingSyncAuthorityV5(owner), 2);
    assert.equal(await db.get(schema.V5_OUTBOX_STORE, [owner, before]), undefined);
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, attempted])).attempts, 1);
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, reloaded])).eventId, reloaded);
    const readIntent = bookId => db.get(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, [owner, bookId]);
    const boundMarker = await readIntent('fresh-book');
    assert.ok(policy.parseLeasedEventId(boundMarker.writeLeaseEventId));
    assert.equal(boundMarker.markerEventId, boundMarker.writeLeaseEventId);
    assert.equal(await db.get(schema.V5_OUTBOX_STORE, [owner, freshIntent]), undefined);
    assert.equal((await db.get(schema.V5_OUTBOX_STORE, [owner, boundMarker.markerEventId])).target.bookId, 'fresh-book');
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
    assert.equal((await readIntent('attempted-book')).expired, undefined);
    assert.equal((await readIntent('claimed-book')).expired, undefined);
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
    const syncNow = issued + 12_000;
    const tabLease = await outbox.acquireSyncLeaseV5(owner, 'marker-tab', syncNow, 1000);
    await db.put(schema.V5_OUTBOX_STORE, { ...await db.get(schema.V5_OUTBOX_STORE, [owner, boundMarker.markerEventId]),
      nextAttemptAt: syncNow });
    const claimedMarker = await outbox.claimNextProgressEventV5(owner, 'marker-tab', tabLease.epoch, syncNow);
    assert.equal(claimedMarker.eventId, boundMarker.markerEventId);
    assert.equal(await outbox.acknowledgeProgressEventV5(owner, claimedMarker.eventId, {
      schemaVersion: 1, bookId: 'fresh-book', annotationId: 'book_delete_marker_v1',
      revision: 2, acceptedEventId: 'newer-marker', operation: 'delete', annotation: null,
      acceptedDeviceId: 'device', acceptedSessionId: 's', bookGeneration: 2,
      occurredAtClient: issued, updatedAtServer: {}, deletedAtServer: {},
    }, outbox.getExpectedClaimV5(claimedMarker), syncNow, 1), true);
    let checkedBooks = [];
    const cleanup = await deletion.reconcileAnnotationBookDeletionIntentsV10('online', owner,
      { deviceId: 'device', sessionId: 's' }, syncNow, async (_, bookId) => {
        checkedBooks.push(bookId);
        return [{ bookId, annotationId: 'old-note', revision: 3, operation: 'upsert' }];
      });
    assert.deepEqual(checkedBooks, ['fresh-book']);
    assert.equal(cleanup.queued, 1);
    const cleanupEvent = (await outbox.getOutboxEventsV5(owner, 'annotation:fresh-book:old-note'))[0];
    assert.equal(cleanupEvent.deleteBeforeBookGeneration, 1);
    const markerAuthority = policy.parseLeasedEventId(claimedMarker.eventId);
    const cleanupAuthority = policy.parseLeasedEventId(cleanupEvent.eventId);
    assert.notEqual(cleanupEvent.eventId, claimedMarker.eventId);
    assert.equal(cleanupAuthority.leaseId, markerAuthority.leaseId);
    assert.equal(cleanupAuthority.issuedAtMillis, markerAuthority.issuedAtMillis);
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
    for (const releaseLock of held.values()) releaseLock();
    await Promise.resolve();
    await Promise.resolve();
    const released = await recovery.listExpiredSyncRecoveryTargets(owner, transport.getTrustedWriteLeaseTime(owner));
    assert.ok(released.some(target => target.bookId === 'attempted-book'));
    assert.ok(released.some(target => target.bookId === 'claimed-book'));
    assert.equal(await outbox.bindPendingSyncAuthorityV5(owner), 0);
    Date.now = () => issued + 2000;
    transport.assertEventWriteLease(leased, owner);
    mono += policy.WRITE_LEASE_DURATION_MS;
    assert.throws(() => transport.assertEventWriteLease(leased, owner), { code: 'sync/write-lease-expired' });
    assert.throws(() => transport.assertEventWriteLease(cleanupEvent.eventId, owner), { code: 'sync/write-lease-expired' });
    const transaction = (await import('./src/lib/progressSyncTransaction.ts')).default;
    assert.throws(() => transaction.decideProgressTransaction({ event: { eventId: leased, ownerKey: owner }, storedReceipt: {}, storedHead: {}, serverTime: {} }), { code: 'sync/write-lease-expired' });
    assert.throws(() => transport.assertEventWriteLease('unleased_reloaded', owner), { code: 'sync/write-lease-pending' });
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('another runtime skips live placeholders, can send unrelated work, and recovers after release', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const firestorePath = require.resolve('firebase/firestore');
    const issued = Date.now();
    require.cache[firestorePath] = { id: firestorePath, filename: firestorePath, loaded: true, exports: {
      doc: () => ({}), serverTimestamp: () => ({}), setDoc: async () => {},
      getDocFromServer: async () => ({ exists: () => true, metadata: { hasPendingWrites: false },
        data: () => ({ schemaVersion: 1, deviceId: 'device', issuedAtServer: { toMillis: () => issued } }) }),
    } };
    const held = new Map();
    let interceptQuery;
    let queryFails = false;
    const locks = {
      request: async (name, options, callback) => {
        if (held.has(name)) return callback(null);
        const end = Promise.withResolvers();
        held.set(name, end.resolve);
        try { return await Promise.race([callback({ name }), end.promise]); }
        finally { held.delete(name); }
      },
      query: async () => {
        const snapshot = { held: [...held.keys()].map(name => ({ name })) };
        if (queryFails) throw new Error('query unavailable');
        if (interceptQuery) await interceptQuery();
        return snapshot;
      },
    };
    Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
    process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
    await import('fake-indexeddb/auto');
    const { initDB } = require('./src/lib/localDB.ts');
    const { V5_OUTBOX_STORE } = require('./src/lib/localDBSchema.ts');
    const owner = 'firebase:shared|library:local';
    const input = (bookId, cfi = 'local') => ({
      bookId, deviceId: 'device', sessionId: 'session', causalViewportId: 'viewport',
      causalRevision: 0, operation: 'progress.set',
      position: { cfi, anchorCfi: null, progressPercent: 20 }, occurredAtClient: issued,
    });
    const runtime = () => {
      for (const module of ['pendingSyncWriter', 'writeLeaseTransport', 'annotationBookDeletion', 'syncOutboxV5', 'expiredSyncRecovery']) {
        delete require.cache[require.resolve('./src/lib/' + module + '.ts')];
      }
      return {
        transport: require('./src/lib/writeLeaseTransport.ts'),
        outbox: require('./src/lib/syncOutboxV5.ts'),
        recovery: require('./src/lib/expiredSyncRecovery.ts'),
      };
    };
    const producer = runtime();
    const old = (await producer.outbox.enqueueProgressEventV5(owner, input('pending'))).event;
    assert.match(old.eventId, /^unleased_v1_/);
    assert.equal(held.size, 1, 'the lock is held before the IndexedDB commit completes');
    const merged = await producer.outbox.enqueueProgressEventV5(owner, input('pending', 'coalesced'));
    assert.equal(merged.coalesced, true);
    assert.equal(merged.event.eventId, old.eventId);
    assert.equal(merged.event.baseRevision, old.baseRevision);
    assert.equal(merged.event.afterPositionToken, old.afterPositionToken);
    const abandoned = (await producer.outbox.enqueueProgressEventV5(owner, input('abandoned'))).event;
    const db = await initDB();

    const other = runtime();
    await other.transport.prepareWriteLease({}, 'shared', owner, 'device');
    assert.notEqual(other.transport.getTrustedWriteLeaseTime(owner), null);
    assert.equal(producer.transport.getTrustedWriteLeaseTime(owner), null);
    assert.equal(await other.outbox.bindPendingSyncAuthorityV5(owner), 0);
    const leased = (await other.outbox.enqueueProgressEventV5(owner, input('independent'))).event;
    const tab = await other.outbox.acquireSyncLeaseV5(owner, 'other-tab', issued, 120_000);
    const claimed = await other.outbox.claimNextProgressEventV5(owner, 'other-tab', tab.epoch, issued);
    assert.equal(claimed.eventId, leased.eventId);
    const expectedClaim = other.outbox.getExpectedClaimV5(claimed);
    const retry = await other.outbox.scheduleProgressEventRetryV5(owner, claimed.eventId, 'unavailable', expectedClaim, issued);
    assert.equal((await other.outbox.claimNextProgressEventV5(owner, 'other-tab', tab.epoch, retry.nextAttemptAt)).eventId, leased.eventId);
    assert.deepEqual(await other.recovery.listExpiredSyncRecoveryTargets(owner, issued), []);
    assert.equal(await other.recovery.quarantineExpiredSyncWork(owner, old.targetKey, issued), 0);
    assert.equal((await db.get(V5_OUTBOX_STORE, [owner, old.eventId])).attempts, 0);
    queryFails = true;
    assert.equal(await other.recovery.quarantineExpiredSyncWork(owner, old.targetKey, issued), 0);
    queryFails = false;

    await producer.transport.prepareWriteLease({}, 'shared', owner, 'device');
    // Simulate a row paused by an older client before this writer shuts down.
    await db.put(V5_OUTBOX_STORE, { ...abandoned, status: 'paused' });
    assert.equal(await producer.outbox.bindPendingSyncAuthorityV5(owner), 1);
    assert.equal(await producer.outbox.bindPendingSyncAuthorityV5(owner), 0);
    assert.equal(await db.get(V5_OUTBOX_STORE, [owner, old.eventId]), undefined);
    const bound = (await other.outbox.getOutboxEventsV5(owner, old.targetKey))[0];
    assert.match(bound.eventId, /^wl1_/);
    assert.equal(bound.payload.cfi, 'coalesced');
    const release = [...held.values()][0];
    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(held.size, 0);
    queryFails = true;
    assert.equal(await other.recovery.quarantineExpiredSyncWork(owner, abandoned.targetKey, issued), 0);
    assert.deepEqual(await other.recovery.listExpiredSyncRecoveryTargets(owner, issued), []);
    queryFails = false;
    assert.deepEqual((await other.recovery.listExpiredSyncRecoveryTargets(owner, issued)).map(target => target.bookId), ['abandoned']);

    // Insert another runtime's live event after the recovery candidate read.
    // It must remain eligible to bind and cannot inherit the earlier query.
    const late = runtime();
    interceptQuery = async () => {
      interceptQuery = undefined;
      const row = (await late.outbox.enqueueProgressEventV5(owner, input('abandoned', 'late'))).event;
      assert.match(row.eventId, /^unleased_v1_/);
    };
    assert.equal(await other.recovery.quarantineExpiredSyncWork(owner, abandoned.targetKey, issued), 1);
    const [original, successor] = await other.outbox.getOutboxEventsV5(owner, abandoned.targetKey);
    assert.equal(original.status, 'expired');
    assert.deepEqual(original.payload, abandoned.payload);
    assert.equal(successor.status, 'pending');
    assert.equal(successor.attempts, 0);
    assert.equal(await other.outbox.bindPendingSyncAuthorityV5(owner), 0);

    const conflictId = 'old-conflict';
    const { V5_SYNC_CONFLICTS_STORE } = require('./src/lib/localDBSchema.ts');
    await db.put(V5_OUTBOX_STORE, { ...successor, status: 'blocked' });
    await db.put(V5_SYNC_CONFLICTS_STORE, {
      ownerKey: owner, conflictId, targetKey: abandoned.targetKey, state: 'open',
      event: original, latestLocalPosition: original.payload, remoteHead: null,
      blockedEventIds: [successor.eventId], createdAt: issued,
    });
    await late.transport.prepareWriteLease({}, 'shared', owner, 'device');
    assert.equal(await late.outbox.bindPendingSyncAuthorityV5(owner), 1);
    const boundSuccessor = (await late.outbox.getOutboxEventsV5(owner, abandoned.targetKey))[1];
    assert.equal(boundSuccessor.status, 'blocked');
    assert.deepEqual((await db.get(V5_SYNC_CONFLICTS_STORE, [owner, conflictId])).blockedEventIds, [boundSuccessor.eventId]);
    const recovery = await other.recovery.recoverExpiredProgressFromServer('shared', owner, 'abandoned', {
      serverTrustedNow: issued, fetchHead: async () => null,
    });
    assert.equal(recovery.status, 'conflict');
    const [preserved, conflict] = await other.outbox.getOutboxEventsV5(owner, abandoned.targetKey);
    assert.equal(preserved.recoveryPending, false);
    assert.deepEqual(preserved.payload, abandoned.payload);
    assert.equal(conflict.status, 'conflict');
    assert.equal(conflict.payload.cfi, 'late');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('without Web Locks the producer can bind on reconnect and a restarted runtime can recover', () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const firestorePath = require.resolve('firebase/firestore');
    const issued = Date.now();
    require.cache[firestorePath] = { id: firestorePath, filename: firestorePath, loaded: true, exports: {
      doc: () => ({}), serverTimestamp: () => ({}), setDoc: async () => {},
      getDocFromServer: async () => ({ exists: () => true, metadata: { hasPendingWrites: false },
        data: () => ({ schemaVersion: 1, deviceId: 'device', issuedAtServer: { toMillis: () => issued } }) }),
    } };
    process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
    await import('fake-indexeddb/auto');
    const { initDB } = require('./src/lib/localDB.ts');
    const { V5_OUTBOX_STORE, V10_ANNOTATION_BOOK_DELETIONS_STORE } = require('./src/lib/localDBSchema.ts');
    const producerTransport = require('./src/lib/writeLeaseTransport.ts');
    const producerOutbox = require('./src/lib/syncOutboxV5.ts');
    const producerRecovery = require('./src/lib/expiredSyncRecovery.ts');
    const { removeBookAndAnnotationsV8 } = require('./src/lib/localDBV5.ts');
    const { DEVICE_CONTENT_OWNER_KEY } = require('./src/lib/ownerIdentity.ts');
    const db = await initDB();
    for (const [uid, locks] of [['no-locks', undefined], ['locks-denied', {
      request: async () => { throw new Error('locks denied'); },
    }]]) {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
      const owner = 'firebase:' + uid + '|library:local';
      const bookId = 'offline';
      const context = { deviceId: 'device', sessionId: 'session' };
      const input = {
        bookId, ...context, causalViewportId: 'viewport', operation: 'progress.set',
        position: { cfi: 'local', anchorCfi: null, progressPercent: 20 }, occurredAtClient: issued,
      };
      const { event } = await producerOutbox.enqueueProgressEventV5(owner, input);
      await removeBookAndAnnotationsV8(owner, DEVICE_CONTENT_OWNER_KEY, 'removed', context);
      const intentKey = [owner, 'removed'];
      const intent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);
      assert.match(event.eventId, /^unleased_untracked_/);
      assert.match(intent.markerEventId, /^unleased_untracked_/);
      assert.deepEqual(await producerRecovery.listExpiredSyncRecoveryTargets(owner, issued), []);
      assert.equal(await producerRecovery.quarantineExpiredSyncWork(owner, event.targetKey, issued), 0);

      for (const module of ['pendingSyncWriter', 'writeLeaseTransport', 'annotationBookDeletion', 'syncOutboxV5', 'expiredSyncRecovery']) {
        delete require.cache[require.resolve('./src/lib/' + module + '.ts')];
      }
      const other = require('./src/lib/writeLeaseTransport.ts');
      const outbox = require('./src/lib/syncOutboxV5.ts');
      const recovery = require('./src/lib/expiredSyncRecovery.ts');
      await other.prepareWriteLease({}, uid, owner, 'device');
      assert.equal(await outbox.bindPendingSyncAuthorityV5(owner), 0);
      const claimAt = Date.now() + 100;
      const tabLease = await outbox.acquireSyncLeaseV5(owner, 'other-tab', claimAt);
      assert.equal(await outbox.claimNextProgressEventV5(owner, 'other-tab', tabLease.epoch, claimAt), null);
      assert.deepEqual(await db.get(V5_OUTBOX_STORE, [owner, event.eventId]), event);
      assert.deepEqual(await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey), intent);

      await producerTransport.prepareWriteLease({}, uid, owner, 'device');
      assert.equal(await producerOutbox.bindPendingSyncAuthorityV5(owner), 2);
      assert.equal(await producerOutbox.bindPendingSyncAuthorityV5(owner), 0);
      assert.equal(await db.get(V5_OUTBOX_STORE, [owner, event.eventId]), undefined);
      const [bound] = await outbox.getOutboxEventsV5(owner, event.targetKey);
      assert.match(bound.eventId, /^wl1_/);
      assert.deepEqual(bound.payload, event.payload);
      const boundIntent = await db.get(V10_ANNOTATION_BOOK_DELETIONS_STORE, intentKey);
      assert.match(boundIntent.markerEventId, /^wl1_/);
      assert.equal(boundIntent.writeLeaseEventId, boundIntent.markerEventId);
      assert.equal(await db.get(V5_OUTBOX_STORE, [owner, intent.markerEventId]), undefined);
      assert.equal((await db.get(V5_OUTBOX_STORE, [owner, boundIntent.markerEventId])).target.bookId, 'removed');
    }

    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const uid = 'no-locks-after-restart';
    const owner = 'firebase:' + uid + '|library:local';
    const input = {
      bookId: 'restart', deviceId: 'device', sessionId: 'session', operation: 'progress.set',
      position: { cfi: 'before-restart', anchorCfi: null, progressPercent: 25 }, occurredAtClient: issued,
    };
    const { event } = await producerOutbox.enqueueProgressEventV5(owner, input);
    const restartedTransport = require('./src/lib/writeLeaseTransport.ts');
    const restartedOutbox = require('./src/lib/syncOutboxV5.ts');
    const restartedRecovery = require('./src/lib/expiredSyncRecovery.ts');
    assert.match(event.eventId, /^unleased_untracked_/);
    assert.deepEqual(await restartedRecovery.listExpiredSyncRecoveryTargets(owner, null), []);
    await restartedTransport.prepareWriteLease({}, uid, owner, 'device');
    assert.equal(await restartedOutbox.bindPendingSyncAuthorityV5(owner), 0);
    assert.deepEqual(await restartedRecovery.listExpiredSyncRecoveryTargets(owner, issued), [event.target]);
    assert.equal((await restartedRecovery.recoverExpiredProgressFromServer(uid, owner, input.bookId, {
      serverTrustedNow: issued, fetchHead: async () => null,
    })).status, 'resynced');
    const [preserved] = await restartedOutbox.getOutboxEventsV5(owner, event.targetKey);
    assert.equal(preserved.eventId, event.eventId);
    assert.equal(preserved.status, 'expired');
    assert.equal(preserved.recoveryPending, false);
    assert.deepEqual(preserved.payload, event.payload);
    await producerTransport.prepareWriteLease({}, uid, owner, 'device');
    assert.equal(await producerOutbox.bindPendingSyncAuthorityV5(owner), 0);
    const { event: next } = await restartedOutbox.enqueueProgressEventV5(owner, input);
    assert.match(next.eventId, /^wl1_/);
    assert.equal(next.status, 'pending');
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('offline cached-lease coalescing requires the same explicit viewport, device, session, and authority', async () => {
  assert.equal((await import('../src/lib/writeLeaseTransport.ts')).getTrustedWriteLeaseTime(ownerKey), null);
  now = initial;
  const first = {
    ...input('cached-coalesce'), causalViewportId: 'first-viewport', causalRevision: 4,
    restoredPositionToken: 'predecessor',
  };
  const original = (await enqueueProgressEventV5(ownerKey, first)).event;
  assert.equal(original.afterPositionToken, 'predecessor');
  const changed = { ...first, position: { ...first.position, cfi: 'last' } };
  const latest = await enqueueProgressEventV5(ownerKey, changed);
  assert.equal(latest.coalesced, true);
  assert.equal(latest.event.eventId, original.eventId);
  assert.equal(latest.event.baseRevision, 4);
  assert.equal(latest.event.afterPositionToken, 'predecessor');
  assert.equal(latest.event.payload.cfi, 'last');

  for (const [bookId, fields, tailPatch] of [
    ['restored-session', { sessionId: 'later' }],
    ['other-viewport', { causalViewportId: 'later' }],
    ['other-device', { deviceId: 'later' }],
    ['changed-lease', {}, { eventId: createLeasedEventId({ ...lease, leaseId: crypto.randomUUID() }) }],
    ['attempted-tail', {}, { attempts: 1 }],
    ['claim-evidence', {}, { claimToken: 'earlier-claim' }],
  ]) {
    const base = { ...first, bookId, ...tailPatch };
    const { event: tail } = await enqueueProgressEventV5(ownerKey, base);
    if (tailPatch?.attempts || tailPatch?.claimToken) await (await initDB()).put(V5_OUTBOX_STORE, { ...tail, ...tailPatch });
    const next = await enqueueProgressEventV5(ownerKey, {
      ...changed, bookId, restoredPositionToken: tail.positionToken, ...fields,
    });
    assert.equal(next.coalesced, false, bookId);
    assert.notEqual(next.event.eventId, tail.eventId, bookId);
  }
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
