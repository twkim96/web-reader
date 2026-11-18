import { randomUUID } from 'node:crypto';
import { FieldPath, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity';
import { isEventReceiptV2 } from '../lib/progressV2Schema';
import { isAnnotationSyncReceiptV1 } from '../lib/annotationSyncSchema';
import { RECEIPT_RETENTION_MS } from '../lib/writeLeasePolicy';

const DAY = 864e5;
const MAX_SCAN = 500;
const MAX_PARENTS = 100;
const PAGE = 50;
type Phase = 'history' | 'annotation' | 'palette';
type Cursor = { version: 2; phase: Phase; parentToken: string; parentId: string; nextToken: string; after: string; afterTime: { seconds: number; nanoseconds: number } | null };
const initialCursor = (): Cursor => ({ version: 2, phase: 'history', parentToken: '', parentId: '', nextToken: '', after: '', afterTime: null });
const timestampMillis = (value: unknown) => value instanceof Timestamp ? value.toMillis() : null;
const policyTime = (policy: unknown, now: number) => {
  if (!policy || typeof policy !== 'object') return null;
  const p = policy as Record<string, unknown>;
  const time = timestampMillis(p.legacyBlockedAtServer);
  return p.schemaVersion === 1 && p.requireLeases === true && time !== null && time <= now ? time : null;
};
const safeSegment = (s: string) => !!s && !s.includes('/') && s !== '.' && s !== '..';
const rootFor = (uid: string) => {
  if (!safeSegment(uid)) throw new Error('Invalid UID');
  return `artifacts/${APP_ID}/users/${uid}/libraries/local`;
};

/** A path must identify exactly one receipt belonging to this UID and matching its payload. */
export function planEligibility(uid: string, path: string, value: unknown, policy: unknown, now: number): boolean {
  const root = rootFor(uid);
  if (!path.startsWith(`${root}/`)) return false;
  const parts = path.slice(root.length + 1).split('/');
  if (parts.length !== 4 || !parts.every(safeSegment) || parts[2] !== 'eventReceipts') return false;
  const [collection, parent, , eventId] = parts;
  const cutover = policyTime(policy, now);
  if (cutover === null || now < cutover + RECEIPT_RETENTION_MS) return false;
  if (collection === 'readingHistoryV2') {
    if (!isEventReceiptV2(value) || value.eventId !== eventId || value.bookId !== parent) return false;
  } else if (collection === 'annotationSyncV1') {
    if (!isAnnotationSyncReceiptV1(value) || value.targetKind !== 'annotation' || value.eventId !== eventId || value.bookId !== parent) return false;
  } else if (collection === 'annotationSettingsV1' && parent === 'palette') {
    if (!isAnnotationSyncReceiptV1(value) || value.targetKind !== 'palette' || value.eventId !== eventId) return false;
  } else return false;
  const created = timestampMillis(value.createdAtServer);
  return created !== null && created <= now && now >= created + RECEIPT_RETENTION_MS;
}

type ParentPage = { id: string | null; nextToken: string };
export type MaintenanceDependencies = {
  db: Firestore;
  // One ListDocuments page with showMissing=true and pageSize=1.
  listParent: (root: string, collection: string, pageToken: string) => Promise<ParentPage>;
  now?: () => number;
  owner?: () => string;
};

/** Uses the Admin SDK's authenticated client pool to page ListDocuments without auto-pagination. */
export function adminMaintenanceDependencies(db: Firestore): MaintenanceDependencies {
  const internal = db as unknown as {
    initializeIfNeeded: (tag: string) => Promise<unknown>;
    projectId: string;
    createCallOptions: (method: string) => object;
    _clientPool: { run: <T>(tag: string, grpc: boolean, fn: (client: { listDocuments: (request: object, options: object) => Promise<[Array<{name?: string}>, {pageToken?: string} | null, {nextPageToken?: string} | null]> }) => Promise<T>) => Promise<T> };
  };
  return { db, listParent: async (root, collection, pageToken) => {
    await internal.initializeIfNeeded('receipt-maintenance');
    const prefix = `projects/${internal.projectId}/databases/${db.databaseId}/documents/${root}/${collection}/`;
    const [docs, next, response] = await internal._clientPool.run('receipt-maintenance', false, client => client.listDocuments({
      parent: `projects/${internal.projectId}/databases/${db.databaseId}/documents/${root}`,
      collectionId: collection, showMissing: true, pageSize: 1, pageToken: pageToken || undefined,
      mask: { fieldPaths: [] },
    }, { ...internal.createCallOptions('listDocuments'), autoPaginate: false }));
    const name = docs[0]?.name;
    if (name && (!name.startsWith(prefix) || !safeSegment(name.slice(prefix.length)))) throw new Error('Invalid parent path');
    return { id: name ? name.slice(prefix.length) : null, nextToken: next?.pageToken || response?.nextPageToken || '' };
  } };
}

const validCursor = (v: unknown): v is Cursor => {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  const time = c.afterTime as Record<string, unknown> | null;
  const validTime = time !== null && typeof time === 'object' && Number.isInteger(time.seconds) && (time.seconds as number) >= -62135596800 && (time.seconds as number) <= 253402300799 && Number.isInteger(time.nanoseconds) && (time.nanoseconds as number) >= 0 && (time.nanoseconds as number) < 1e9;
  return c.version === 2 && (c.after ? validTime : c.afterTime === null) && (c.phase === 'history' || c.phase === 'annotation' || c.phase === 'palette')
    && ['parentToken', 'parentId', 'nextToken', 'after'].every(k => typeof c[k] === 'string' && (c[k] as string).length <= 4096)
    && (!c.parentId || safeSegment(c.parentId as string)) && (!c.after || safeSegment(c.after as string));
};

export async function maintenanceAdmin(uid: string, deps: MaintenanceDependencies, options: { dryRun?: boolean } = {}) {
  const { db, listParent } = deps;
  const clock = deps.now ?? Date.now;
  const started = clock();
  const dryRun = options.dryRun !== false;
  const root = rootFor(uid);
  const policyRef = db.doc(`${root}/syncPolicyV1/writeLease`);
  const leaseRef = db.doc(`${root}/syncMaintenanceV1/receipts`);
  const policySnapshot = await policyRef.get();
  const policy = policySnapshot.data();
  const policyVersion = policySnapshot.updateTime;
  const unchanged = (snapshot: FirebaseFirestore.DocumentSnapshot) => !!policyVersion && !!snapshot.updateTime && policyVersion.isEqual(snapshot.updateTime);
  const cutover = policyTime(policy, started);
  if (cutover === null || started < cutover + RECEIPT_RETENTION_MS) return { status: 'waiting-for-cutover', scanned: 0, deleted: 0, reads: 1, writes: 0 };
  const owner = (deps.owner ?? randomUUID)();
  let reads = 1, writes = 0, scanned = 0, deleted = 0, wouldDelete = 0, parents = 0;
  let cursor = initialCursor();
  if (!dryRun) {
    const claim = await db.runTransaction(async tx => {
      const [p, l] = await Promise.all([tx.get(policyRef), tx.get(leaseRef)]);
      const current = policyTime(p.data(), clock());
      if (current !== cutover || !unchanged(p)) return { status: 'waiting-for-cutover' as const };
      const data = l.data();
      if (typeof data?.nextRun === 'number' && data.nextRun > started) return { status: 'throttled' as const };
      if (typeof data?.leaseUntil === 'number' && data.leaseUntil > started) return { status: 'busy' as const };
      tx.set(leaseRef, { owner, leaseUntil: started + 120000, nextRun: data?.nextRun ?? 0, cursor: validCursor(data?.cursor) ? data.cursor : initialCursor() });
      return { status: 'claimed' as const, cursor: validCursor(data?.cursor) ? data.cursor : initialCursor() };
    });
    reads += 2;
    if (claim.status !== 'claimed') return { status: claim.status, scanned, deleted, reads, writes };
    writes++;
    cursor = claim.cursor;
  }
  let done = false, stopped = false;
  while (scanned < MAX_SCAN && parents < MAX_PARENTS && clock() - started < 40000 && !done) {
    if (!cursor.parentId && cursor.phase !== 'palette') {
      const page = await listParent(root, cursor.phase === 'history' ? 'readingHistoryV2' : 'annotationSyncV1', cursor.parentToken);
      reads++;
      parents++;
      if (!page.id) {
        cursor = cursor.phase === 'history' ? { ...initialCursor(), phase: 'annotation' } : { ...initialCursor(), phase: 'palette' };
        continue;
      }
      if (!safeSegment(page.id)) throw new Error('Invalid parent id');
      cursor = { ...cursor, parentId: page.id, nextToken: page.nextToken, after: '', afterTime: null };
    }
    const parentPath = cursor.phase === 'palette' ? `${root}/annotationSettingsV1/palette` : `${root}/${cursor.phase === 'history' ? 'readingHistoryV2' : 'annotationSyncV1'}/${cursor.parentId}`;
    let query = db.collection(`${parentPath}/eventReceipts`)
      .where('createdAtServer', '<=', Timestamp.fromMillis(started - RECEIPT_RETENTION_MS))
      .orderBy('createdAtServer').orderBy(FieldPath.documentId()).limit(Math.min(PAGE, MAX_SCAN - scanned));
    if (cursor.after && cursor.afterTime) query = query.startAfter(new Timestamp(cursor.afterTime.seconds, cursor.afterTime.nanoseconds), cursor.after);
    const snapshot = await query.get();
    // Estimates document reads, including Firestore's minimum charge for an empty query.
    // Transaction retries, index-entry reads and ListDocuments billing can differ.
    reads += Math.max(1, snapshot.size);
    scanned += snapshot.size;
    const candidates = snapshot.docs.filter(doc => planEligibility(uid, doc.ref.path, doc.data(), policy, started));
    if (!dryRun && candidates.length) {
      const result = await db.runTransaction(async tx => {
        const [p, lease] = await Promise.all([tx.get(policyRef), tx.get(leaseRef)]);
        if (policyTime(p.data(), clock()) !== cutover || !unchanged(p) || lease.data()?.owner !== owner || lease.data()?.leaseUntil <= clock()) return { valid: false, count: 0 };
        const current = await Promise.all(candidates.map(doc => tx.get(doc.ref)));
        let count = 0;
        for (const doc of current) if (doc.exists && planEligibility(uid, doc.ref.path, doc.data(), p.data(), started)) { tx.delete(doc.ref); count++; }
        return { valid: true, count };
      });
      reads += 2 + candidates.length;
      if (!result.valid) { stopped = true; break; }
      deleted += result.count; writes += result.count;
    } else if (dryRun) wouldDelete += candidates.length;
    if (snapshot.size === PAGE || scanned === MAX_SCAN) {
      if (snapshot.size) {
        const last = snapshot.docs[snapshot.size - 1];
        const time = last.get('createdAtServer') as Timestamp;
        cursor = { ...cursor, after: last.id, afterTime: { seconds: time.seconds, nanoseconds: time.nanoseconds } };
      }
      continue;
    }
    if (cursor.phase === 'palette') { done = true; cursor = initialCursor(); }
    else if (cursor.nextToken) cursor = { ...cursor, parentToken: cursor.nextToken, parentId: '', nextToken: '', after: '', afterTime: null };
    else cursor = cursor.phase === 'history' ? { ...initialCursor(), phase: 'annotation' } : { ...initialCursor(), phase: 'palette' };
  }
  if (!dryRun) {
    const finalized = await db.runTransaction(async tx => {
      const [p, l] = await Promise.all([tx.get(policyRef), tx.get(leaseRef)]);
      if (l.data()?.owner !== owner) return 'lost' as const;
      if (stopped || policyTime(p.data(), clock()) !== cutover || !unchanged(p)) {
        tx.set(leaseRef, { ...l.data(), owner: '', leaseUntil: 0 });
        return 'changed' as const;
      }
      tx.set(leaseRef, { owner: '', leaseUntil: 0, nextRun: clock() + DAY, cursor });
      return 'ok' as const;
    });
    reads += 2; if (finalized !== 'lost') writes++;
    if (finalized !== 'ok') stopped = true;
  }
  return { status: stopped ? 'waiting-for-cutover' : done ? 'complete' : 'partial', scanned, deleted, wouldDelete, reads, writes, dryRun };
}


/** Route boundary with injected authentication and maintenance for focused tests. */
export function createMaintenancePost(deps: {
  enabled: () => boolean;
  verifyToken: (token: string) => Promise<{ uid: string }>;
  run: (uid: string) => Promise<object>;
}) {
  const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  return async (request: Request) => {
    if (!deps.enabled()) return reply({ status: 'disabled' }, 404);
    const token = request.headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    if (!token) return reply({ status: 'unauthorized' }, 401);
    let uid: string;
    try { uid = (await deps.verifyToken(token)).uid; }
    catch { return reply({ status: 'unauthorized' }, 401); }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 1024) return reply({ status: 'invalid-request' }, 413);
    if (text.trim()) {
      try {
        const body: unknown = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) return reply({ status: 'invalid-request' }, 400);
      } catch { return reply({ status: 'invalid-request' }, 400); }
    }
    try { return reply(await deps.run(uid)); }
    catch { return reply({ status: 'error' }, 500); }
  };
}
