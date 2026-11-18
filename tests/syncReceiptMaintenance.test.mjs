import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { createMaintenancePost, maintenanceAdmin, planEligibility } from '../src/server/syncReceiptMaintenance.ts';
import { APP_ID } from '../src/lib/appIdentity.ts';
import { RECEIPT_RETENTION_MS as age } from '../src/lib/writeLeasePolicy.ts';

const now = 1800000000000;
const root = `artifacts/${APP_ID}/users/alice/libraries/local`;
const policyPath = `${root}/syncPolicyV1/writeLease`;
const leasePath = `${root}/syncMaintenanceV1/receipts`;
const receiptPath = `${root}/readingHistoryV2/book/eventReceipts/event`;
const policy = () => ({ schemaVersion: 1, requireLeases: true, legacyBlockedAtServer: Timestamp.fromMillis(now - age) });
const receipt = () => ({ schemaVersion: 2, eventId: 'event', targetKind: 'progress', bookId: 'book', bookmarkId: null, targetKey: 'progress:book', revision: 1, createdAtServer: Timestamp.fromMillis(now - age) });

function fake() {
  const store = new Map([[policyPath, policy()], [receiptPath, receipt()], [`${root}/readingHistoryV2/book`, { head: true }]]);
  let version = 1, chain = Promise.resolve(), onTransaction = () => {};
  const ref = path => ({ path, id: path.split('/').at(-1), async get() { return snap(path); } });
  const snap = path => {
    const value = store.get(path);
    return { ref: ref(path), id: path.split('/').at(-1), exists: store.has(path), data: () => value, get: field => value?.[field], updateTime: path === policyPath && store.has(path) ? { isEqual: other => other.value === version, value: version } : undefined };
  };
  const db = {
    doc: ref,
    collection(path) {
      let cutoff, after, limit = 50;
      const compareTime = (a, b) => a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;
      const order = [];
      const query = {
        where(field, op, value) { assert.equal(field, 'createdAtServer'); assert.equal(op, '<='); cutoff = value; return query; },
        orderBy(field) { order.push(typeof field === 'string' ? field : '__name__'); return query; },
        limit(n) { limit = n; return query; },
        startAfter(time, id) { after = { time, id }; return query; },
        async get() {
          assert.deepEqual(order, ['createdAtServer', '__name__']);
          assert.ok(cutoff instanceof Timestamp);
          const docs = [...store.keys()].filter(key => {
            if (!key.startsWith(`${path}/`) || key.slice(path.length + 1).includes('/')) return false;
            const time = store.get(key)?.createdAtServer;
            if (!(time instanceof Timestamp) || compareTime(time, cutoff) > 0) return false;
            const id = key.split('/').at(-1);
            return !after || compareTime(time, after.time) > 0 || (compareTime(time, after.time) === 0 && id > after.id);
          }).sort((a, b) => compareTime(store.get(a).createdAtServer, store.get(b).createdAtServer) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit).map(snap);
          return { docs, size: docs.length };
        },
      }; return query;
    },
    runTransaction(fn) {
      const run = async () => {
        onTransaction();
        const operations = [];
        const tx = { get: async r => snap(r.path), set: (r, data) => operations.push(() => store.set(r.path, data)), delete: r => operations.push(() => store.delete(r.path)) };
        const result = await fn(tx); operations.forEach(operation => operation()); return result;
      };
      const result = chain.then(run); chain = result.then(() => {}, () => {}); return result;
    },
  };
  const deps = { db, now: () => now, listParent: async (_root, collection, token) => collection === 'readingHistoryV2' && !token ? { id: 'book', nextToken: '' } : { id: null, nextToken: '' } };
  return { store, deps, mutatePolicy(value) { store.set(policyPath, value); version++; }, onTransaction(fn) { onTransaction = fn; } };
}

test('both 210 day barriers, exact schema and canonical UID/path are required', () => {
  for (const delta of [-1, 0, 1]) {
    assert.equal(planEligibility('alice', receiptPath, { ...receipt(), createdAtServer: Timestamp.fromMillis(now - age + delta) }, policy(), now), delta <= 0);
    assert.equal(planEligibility('alice', receiptPath, receipt(), { ...policy(), legacyBlockedAtServer: Timestamp.fromMillis(now - age + delta) }, now), delta <= 0);
  }
  assert.equal(planEligibility('alice', receiptPath.replace('/alice/', '/bob/'), receipt(), policy(), now), false);
  assert.equal(planEligibility('alice', receiptPath, { ...receipt(), createdAtServer: now - age }, policy(), now), false);
  assert.equal(planEligibility('alice', receiptPath, { ...receipt(), extra: 1 }, policy(), now), false);
  assert.equal(planEligibility('alice', receiptPath, receipt(), { ...policy(), legacyBlockedAtServer: now - age }, now), false);
  assert.equal(planEligibility('alice', receiptPath, receipt(), { ...policy(), legacyBlockedAtServer: Timestamp.fromMillis(now + 1) }, now), false);
  const withoutVersion = { ...policy() };
  delete withoutVersion.schemaVersion;
  assert.equal(planEligibility('alice', receiptPath, receipt(), withoutVersion, now), false);
  assert.equal(planEligibility('alice', receiptPath, receipt(), { ...policy(), schemaVersion: 2 }, now), false);
});

test('deletes only eligible receipts and retains head and other UID', async () => {
  const f = fake();
  const foreign = receiptPath.replace('/alice/', '/bob/'); f.store.set(foreign, receipt());
  f.store.set(`${root}/readingHistoryV2/book/eventReceipts/bad`, { ...receipt(), eventId: 'bad', extra: true });
  const result = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(result.deleted, 1); assert.equal(f.store.has(receiptPath), false);
  assert.equal(f.store.has(`${root}/readingHistoryV2/book`), true); assert.equal(f.store.has(foreign), true);
  assert.equal(f.store.has(`${root}/readingHistoryV2/book/eventReceipts/bad`), true);
  assert.equal((await maintenanceAdmin('alice', f.deps, { dryRun: false })).status, 'throttled');
});

test('dry run defaults to no mutations', async () => {
  const f = fake(); const before = [...f.store];
  const result = await maintenanceAdmin('alice', f.deps);
  assert.equal(result.deleted, 0); assert.equal(result.wouldDelete, 1); assert.deepEqual([...f.store], before);
});

test('missing policy waits before any write', async () => {
  const f = fake(); f.store.delete(policyPath);
  const result = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(result.status, 'waiting-for-cutover'); assert.equal(result.scanned, 0); assert.equal(f.store.has(leasePath), false);
});

test('policy revert between claim and deletion prevents deletion', async () => {
  const f = fake(); let calls = 0;
  f.onTransaction(() => { if (++calls === 2) f.mutatePolicy({ ...policy(), requireLeases: false }); });
  const result = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(result.status, 'waiting-for-cutover'); assert.equal(result.deleted, 0); assert.equal(f.store.has(receiptPath), true);
});

test('concurrent claims perform at most one cleanup', async () => {
  const f = fake();
  const results = await Promise.all([maintenanceAdmin('alice', f.deps, { dryRun: false }), maintenanceAdmin('alice', f.deps, { dryRun: false })]);
  assert.equal(results.reduce((sum, r) => sum + r.deleted, 0), 1);
  assert.equal(results.filter(r => r.status === 'busy' || r.status === 'throttled').length, 1);
});

test('bounded scans resume after 500 candidates across daily runs', async () => {
  const f = fake(); let clock = now;
  f.deps.now = () => clock;
  for (let i = 0; i < 510; i++) {
    const id = `e${String(i).padStart(3, '0')}`;
    f.store.set(`${root}/readingHistoryV2/book/eventReceipts/${id}`, { ...receipt(), eventId: id });
  }
  const first = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(first.status, 'partial'); assert.equal(first.scanned, 500); assert.equal(first.deleted, 500);
  clock += 864e5;
  const second = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(second.status, 'complete'); assert.equal(second.deleted, 11);
});

test('age filter excludes young receipts and visits older later IDs first', async () => {
  const f = fake();
  f.store.delete(receiptPath);
  const path = id => `${root}/readingHistoryV2/book/eventReceipts/${id}`;
  for (let i = 0; i < 500; i++) {
    const id = `a${String(i).padStart(3, '0')}`;
    f.store.set(path(id), { ...receipt(), eventId: id });
  }
  f.store.set(path('z-old'), { ...receipt(), eventId: 'z-old', createdAtServer: Timestamp.fromMillis(now - age - 1) });
  f.store.set(path('0-young'), { ...receipt(), eventId: '0-young', createdAtServer: Timestamp.fromMillis(now - age + 1) });
  const result = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(result.scanned, 500);
  assert.equal(f.store.has(path('z-old')), false);
  assert.equal(f.store.has(path('a499')), true);
  assert.equal(f.store.has(path('0-young')), true);
});

test('equal timestamps resume by ID with nanosecond precision', async () => {
  const f = fake(); let clock = now;
  f.deps.now = () => clock;
  f.store.delete(receiptPath);
  const time = new Timestamp(Math.floor((now - age) / 1000) - 1, 123456789);
  for (let i = 0; i < 501; i++) {
    const id = `e${String(i).padStart(3, '0')}`;
    f.store.set(`${root}/readingHistoryV2/book/eventReceipts/${id}`, { ...receipt(), eventId: id, createdAtServer: time });
  }
  const first = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(first.deleted, 500);
  assert.deepEqual(f.store.get(leasePath).cursor.afterTime, { seconds: time.seconds, nanoseconds: time.nanoseconds });
  clock += 864e5;
  const second = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(second.status, 'complete'); assert.equal(second.deleted, 1);
});

test('legacy ID cursor restarts instead of skipping older eligible receipts', async () => {
  const f = fake();
  f.store.set(leasePath, { nextRun: 0, cursor: { phase: 'history', parentToken: '', parentId: 'book', nextToken: '', after: 'z' } });
  const result = await maintenanceAdmin('alice', f.deps, { dryRun: false });
  assert.equal(result.status, 'complete'); assert.equal(result.deleted, 1);
  assert.equal(f.store.has(receiptPath), false);
});

test('annotation and palette receipts require their matching paths', () => {
  const base = { schemaVersion: 1, eventId: 'event', revision: 1, createdAtServer: Timestamp.fromMillis(now - age) };
  const annotation = { ...base, targetKind: 'annotation', bookId: 'book', annotationId: 'a', targetKey: 'annotation:book:a' };
  const palette = { ...base, targetKind: 'palette', bookId: null, annotationId: null, targetKey: 'annotation-palette' };
  assert.equal(planEligibility('alice', `${root}/annotationSyncV1/book/eventReceipts/event`, annotation, policy(), now), true);
  assert.equal(planEligibility('alice', `${root}/annotationSettingsV1/palette/eventReceipts/event`, palette, policy(), now), true);
  assert.equal(planEligibility('alice', `${root}/annotationSyncV1/book/eventReceipts/event`, palette, policy(), now), false);
});


test('route requires enablement and verified bearer, rejects request UID and uses token UID', async () => {
  let enabled = false; const calls = [];
  const post = createMaintenancePost({
    enabled: () => enabled,
    verifyToken: async token => { calls.push(['verify', token]); if (token !== 'good') throw Error('revoked'); return { uid: 'alice' }; },
    run: async uid => { calls.push(['run', uid]); return { status: 'complete' }; },
  });
  const request = (authorization, body) => new Request('http://localhost/api/sync/maintenance', { method: 'POST', headers: authorization ? { authorization } : {}, body });
  let response = await post(request('Bearer good'));
  assert.equal(response.status, 404); assert.deepEqual(calls, []);
  enabled = true;
  assert.equal((await post(request())).status, 401);
  assert.equal((await post(request('Bearer revoked'))).status, 401);
  assert.equal((await post(request('Bearer good', '{"uid":"bob"}'))).status, 400);
  assert.equal((await post(request('Bearer good', '{'))).status, 400);
  assert.equal((await post(request('Bearer good', 'x'.repeat(1025)))).status, 413);
  response = await post(request('Bearer good', '{}'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls.filter(([kind]) => kind === 'run'), [['run', 'alice']]);
});
