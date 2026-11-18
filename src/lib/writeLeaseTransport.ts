import { doc, getDocFromServer, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import { splitOwnerKey, type OwnerKey } from './ownerIdentity';
import {
  createLeasedEventId, getEventLeaseStatus, isWriteLeaseValid,
  WRITE_LEASE_REFRESH_MS, type WriteLease,
} from './writeLeasePolicy';

// Vercel production enables leases after the compatible Rules are released.
export const finiteWriteLeasesEnabled = () => process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES === '1';
const leases = new Map<OwnerKey, WriteLease>();
const pending = new Map<OwnerKey, Promise<WriteLease>>();
const maintenanceRequests = new Map<string, number>();
let clockAnchor: { server: number; monotonic: number } | null = null;
const ownerClockAnchors = new Map<OwnerKey, { server: number; monotonic: number }>();
const placeholders = new Map<string, { owner: OwnerKey; device: string; resolved?: string }>();
const monotonicNow = () => performance.now();
export const getTrustedWriteLeaseNow = (): number | null => clockAnchor
  ? clockAnchor.server + Math.max(0, monotonicNow() - clockAnchor.monotonic) : null;
export const getTrustedWriteLeaseTime = (ownerKey: OwnerKey): number | null => {
  const anchor = ownerClockAnchors.get(ownerKey);
  return anchor ? anchor.server + Math.max(0, monotonicNow() - anchor.monotonic) : null;
};
const cacheKey = (owner: OwnerKey) => `sync_write_lease_v1:${owner}`;

const readCachedLease = (owner: OwnerKey): WriteLease | undefined => {
  if (leases.has(owner)) return leases.get(owner);
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(cacheKey(owner));
    const value = raw ? JSON.parse(raw) as WriteLease : undefined;
    if (value && isWriteLeaseValid(value, value.issuedAtMillis)) { leases.set(owner, value); return value; }
  } catch { /* An invalid cache never grants permission. */ }
  return undefined;
};

export const createSyncEventId = (ownerKey: OwnerKey, deviceId?: string) => {
  if (!finiteWriteLeasesEnabled() || !ownerKey.startsWith('firebase:')) return crypto.randomUUID();
  const lease = readCachedLease(ownerKey);
  const trustedNow = getTrustedWriteLeaseTime(ownerKey);
  if (lease && (!deviceId || lease.deviceId === deviceId)
    && (trustedNow === null || isWriteLeaseValid(lease, trustedNow))) return createLeasedEventId(lease);
  const id = `unleased_${crypto.randomUUID()}`;
  if (deviceId) placeholders.set(id, { owner: ownerKey, device: deviceId });
  return id;
};
export const isPendingSyncEventId = (ownerKey: OwnerKey, eventId: string, deviceId: string): boolean => {
  const entry = placeholders.get(eventId);
  return Boolean(entry && entry.owner === ownerKey && entry.device === deviceId);
};

export const resolvePendingWriteLeaseEventId = (ownerKey: OwnerKey, eventId: string, deviceId: string): string | null => {
  const entry = placeholders.get(eventId);
  if (!entry || entry.owner !== ownerKey || entry.device !== deviceId) return null;
  if (entry.resolved) return entry.resolved;
  const lease = leases.get(ownerKey);
  const now = getTrustedWriteLeaseTime(ownerKey);
  if (!lease || lease.deviceId !== deviceId || now === null || !isWriteLeaseValid(lease, now)) return null;
  entry.resolved = createLeasedEventId(lease);
  return entry.resolved;
};
export const resolvePendingSyncEventId = resolvePendingWriteLeaseEventId;

export const prepareWriteLease = async (firestore: Firestore, uid: string, ownerKey: OwnerKey, deviceId: string): Promise<WriteLease> => {
  if (splitOwnerKey(ownerKey).authOwnerKey !== `firebase:${uid}` || !deviceId || deviceId.length > 128) {
    throw new Error('동기화 계정 또는 기기 식별자가 올바르지 않습니다.');
  }
  const current = readCachedLease(ownerKey);
  const trustedNow = getTrustedWriteLeaseTime(ownerKey);
  if (trustedNow !== null && current?.deviceId === deviceId && isWriteLeaseValid(current, trustedNow)
    && trustedNow - current.issuedAtMillis < WRITE_LEASE_REFRESH_MS) return current;
  const existing = pending.get(ownerKey);
  if (existing) {
    const result = await existing;
    return result.deviceId === deviceId ? result : prepareWriteLease(firestore, uid, ownerKey, deviceId);
  }
  const work = (async () => {
    const leaseId = crypto.randomUUID();
    const ref = doc(firestore, `artifacts/${APP_ID}/users/${uid}/libraries/local/writeLeases/${leaseId}`);
    await setDoc(ref, { schemaVersion: 1, deviceId, issuedAtServer: serverTimestamp() });
    const snapshot = await getDocFromServer(ref);
    const value = snapshot.data();
    const issuedAtMillis = Math.floor(value?.issuedAtServer?.toMillis?.());
    const lease = { leaseId, deviceId, issuedAtMillis };
    if (!snapshot.exists() || value?.schemaVersion !== 1 || value?.deviceId !== deviceId
      || snapshot.metadata.hasPendingWrites || !isWriteLeaseValid(lease, issuedAtMillis)) throw new Error('서버 쓰기 권한을 확인하지 못했습니다.');
    clockAnchor = { server: issuedAtMillis, monotonic: monotonicNow() };
    ownerClockAnchors.set(ownerKey, clockAnchor);
    leases.set(ownerKey, lease);
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey(ownerKey), JSON.stringify(lease)); } catch { /* Memory permission still works for this session. */ }
    return lease;
  })();
  pending.set(ownerKey, work);
  try { return await work; } finally { if (pending.get(ownerKey) === work) pending.delete(ownerKey); }
};

export const assertEventWriteLease = (eventId: string, ownerKey?: OwnerKey) => {
  if (!finiteWriteLeasesEnabled()) return;
  const now = ownerKey ? getTrustedWriteLeaseTime(ownerKey) : getTrustedWriteLeaseNow();
  if (now === null && eventId.startsWith('wl1_')) return;
  if (now === null || getEventLeaseStatus(eventId, now, true) === 'unleased') {
    throw Object.assign(new Error('서버 쓰기 권한 확인을 기다리고 있습니다.'), { code: 'sync/write-lease-pending' });
  }
  if (getEventLeaseStatus(eventId, now, true) !== 'valid') {
    throw Object.assign(new Error('이전 동기화 작업의 유효기간이 끝났습니다.'), { code: 'sync/write-lease-expired' });
  }
};

export const requestReceiptMaintenance = async (uid: string, getToken: () => Promise<string>) => {
  if (!finiteWriteLeasesEnabled() || Date.now() - (maintenanceRequests.get(uid) ?? 0) < WRITE_LEASE_REFRESH_MS) return;
  maintenanceRequests.set(uid, Date.now());
  try {
    const response = await fetch('/api/sync/maintenance', {
      method: 'POST', headers: { Authorization: `Bearer ${await getToken()}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok && response.status !== 404 && response.status !== 503) maintenanceRequests.delete(uid);
  } catch (error) {
    maintenanceRequests.delete(uid);
    throw error;
  }
};
