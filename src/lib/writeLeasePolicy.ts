export const WRITE_LEASE_DURATION_MS = 90 * 864e5;
export const RECEIPT_RETENTION_GRACE_MS = 30 * 864e5;
export const RECEIPT_RETENTION_MS = WRITE_LEASE_DURATION_MS + RECEIPT_RETENTION_GRACE_MS;
export const WRITE_LEASE_REFRESH_MS = 864e5;

export type WriteLease = {
  leaseId: string;
  deviceId: string;
  issuedAtMillis: number;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuidPattern = new RegExp(`^${UUID}$`);
const leasedEventPattern = new RegExp(`^wl1_(${UUID})_([0-9]{13})_(${UUID})$`);

export function parseLeasedEventId(id: string): { leaseId: string; issuedAtMillis: number; eventId: string } | null {
  const match = leasedEventPattern.exec(id);
  return match ? { leaseId: match[1], issuedAtMillis: Number(match[2]), eventId: match[3] } : null;
}

export function createLeasedEventId(lease: WriteLease): string {
  if (!uuidPattern.test(lease.leaseId) || !Number.isSafeInteger(lease.issuedAtMillis)
    || !/^[0-9]{13}$/.test(String(lease.issuedAtMillis)) || !lease.deviceId) {
    throw new Error('Invalid write lease');
  }
  return `wl1_${lease.leaseId}_${lease.issuedAtMillis}_${crypto.randomUUID()}`;
}

export function isWriteLeaseValid(lease: WriteLease, nowMillis: number): boolean {
  return uuidPattern.test(lease.leaseId) && typeof lease.deviceId === 'string'
    && lease.deviceId.length > 0 && lease.deviceId.length <= 128
    && Number.isSafeInteger(lease.issuedAtMillis) && /^[0-9]{13}$/.test(String(lease.issuedAtMillis))
    && Number.isFinite(nowMillis) && nowMillis >= lease.issuedAtMillis
    && nowMillis < lease.issuedAtMillis + WRITE_LEASE_DURATION_MS;
}

export function getEventLeaseStatus(id: string, nowMillis: number, requireLeases: boolean): 'legacy' | 'valid' | 'expired' | 'unleased' {
  if (id.startsWith('unleased_')) return 'unleased';
  const parsed = parseLeasedEventId(id);
  if (!parsed) return id.startsWith('wl1_') || requireLeases ? 'unleased' : 'legacy';
  if (!Number.isFinite(nowMillis) || nowMillis < parsed.issuedAtMillis) return 'unleased';
  return nowMillis < parsed.issuedAtMillis + WRITE_LEASE_DURATION_MS ? 'valid' : 'expired';
}
