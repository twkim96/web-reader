export type ReaderSyncRecovery = {
  identity: string;
  cfi: string;
  percent: number;
};

type RecoveryRecord = { identity: string; candidate: ReaderSyncRecovery | null };
const KEY = 'reader_sync_recovery_v1';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const storage = (): StorageLike | null => {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
};

// A bounded, device-local recovery history; never a canonical progress write.
export const readSyncRecovery = (scope?: string, target = storage()): RecoveryRecord | null => {
  if (!scope || !target) return null;
  try {
    const record = JSON.parse(target.getItem(KEY) || '{}')[scope];
    if (!record || typeof record.identity !== 'string') return null;
    const candidate = record.candidate;
    if (candidate !== null && (!candidate || candidate.identity !== record.identity
      || typeof candidate.cfi !== 'string' || !candidate.cfi
      || !Number.isFinite(candidate.percent) || candidate.percent < 0 || candidate.percent > 100)) return null;
    return record;
  } catch { return null; }
};

export const writeSyncRecovery = (scope: string | undefined, record: RecoveryRecord, target = storage()) => {
  if (!scope || !target) return false;
  try {
    const records = JSON.parse(target.getItem(KEY) || '{}');
    const entries = Object.entries(records).filter(([key]) => key !== scope).slice(-63);
    target.setItem(KEY, JSON.stringify(Object.fromEntries([...entries, [scope, record]])));
    return true;
  } catch { return false; }
};
