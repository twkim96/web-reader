import type { OwnerKey } from './ownerIdentity';

export const READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY = 'reading_statistics_hidden_sessions_v1';

const STORAGE_VERSION = 1;
const MAX_HIDDEN_ROUNDS = 2_000;
const MAX_HIDDEN_SESSION_IDS = 50_000;
const MAX_SESSION_IDS_PER_ROUND = MAX_HIDDEN_SESSION_IDS;
const MAX_ID_LENGTH = 1_000;
const MAX_ROUND_NUMBER = 1_000_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

type HiddenRoundEntry = {
  ownerKey: OwnerKey;
  bookId: string;
  roundNumber: number;
  sessionIds: string[];
  hiddenAt: number;
};

const defaultStorage = (): StorageLike | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const normalizeSessionIds = (values: unknown) => {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
  )))].slice(0, MAX_SESSION_IDS_PER_ROUND);
};

const parseEntry = (value: unknown): HiddenRoundEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<HiddenRoundEntry>;
  const sessionIds = normalizeSessionIds(entry.sessionIds);
  if (
    typeof entry.ownerKey !== 'string'
    || !entry.ownerKey
    || entry.ownerKey.length > MAX_ID_LENGTH
    || typeof entry.bookId !== 'string'
    || !entry.bookId
    || entry.bookId.length > MAX_ID_LENGTH
    || !Number.isSafeInteger(entry.roundNumber)
    || Number(entry.roundNumber) <= 0
    || Number(entry.roundNumber) > MAX_ROUND_NUMBER
    || sessionIds.length === 0
    || !Number.isSafeInteger(entry.hiddenAt)
    || Number(entry.hiddenAt) <= 0
  ) return null;
  return { ...entry, sessionIds } as HiddenRoundEntry;
};

const capEntries = (entries: HiddenRoundEntry[]) => {
  let remainingSessionIds = MAX_HIDDEN_SESSION_IDS;
  const capped: HiddenRoundEntry[] = [];
  for (const entry of entries
    .sort((left, right) => right.hiddenAt - left.hiddenAt)
    .slice(0, MAX_HIDDEN_ROUNDS)) {
    if (remainingSessionIds <= 0) break;
    const sessionIds = entry.sessionIds.slice(0, remainingSessionIds);
    if (sessionIds.length === 0) continue;
    capped.push({ ...entry, sessionIds });
    remainingSessionIds -= sessionIds.length;
  }
  return capped;
};

const readEntries = (storage: StorageLike | null): HiddenRoundEntry[] => {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY) || '{}',
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const record = parsed as { version?: unknown; entries?: unknown };
    if (record.version !== STORAGE_VERSION || !Array.isArray(record.entries)) return [];
    const byIdentity = new Map<string, HiddenRoundEntry>();
    for (const value of record.entries) {
      const entry = parseEntry(value);
      if (!entry) continue;
      const identity = JSON.stringify([entry.ownerKey, entry.bookId, entry.roundNumber]);
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, entry);
        continue;
      }
      byIdentity.set(identity, {
        ...entry,
        sessionIds: normalizeSessionIds([...existing.sessionIds, ...entry.sessionIds]),
        hiddenAt: Math.max(existing.hiddenAt, entry.hiddenAt),
      });
    }
    return capEntries([...byIdentity.values()]);
  } catch {
    return [];
  }
};

export const readHiddenReadingStatisticsSessionIds = (
  ownerKey: OwnerKey,
  storage: StorageLike | null = defaultStorage(),
) => new Set(readEntries(storage)
  .filter((entry) => entry.ownerKey === ownerKey)
  .flatMap((entry) => entry.sessionIds));

export const hideReadingStatisticsRound = (
  ownerKey: OwnerKey,
  bookId: string,
  roundNumber: number,
  sessionIds: readonly string[],
  storage: StorageLike | null = defaultStorage(),
  hiddenAt = Date.now(),
) => {
  const normalizedSessionIds = normalizeSessionIds(sessionIds);
  if (
    !storage
    || !ownerKey
    || ownerKey.length > MAX_ID_LENGTH
    || !bookId
    || bookId.length > MAX_ID_LENGTH
    || !Number.isSafeInteger(roundNumber)
    || roundNumber <= 0
    || roundNumber > MAX_ROUND_NUMBER
    || normalizedSessionIds.length === 0
    || !Number.isSafeInteger(hiddenAt)
    || hiddenAt <= 0
  ) return false;
  const identity = JSON.stringify([ownerKey, bookId, roundNumber]);
  const entries = readEntries(storage);
  const existing = entries.find((entry) => (
    JSON.stringify([entry.ownerKey, entry.bookId, entry.roundNumber]) === identity
  ));
  const next = entries.filter((entry) => (
    JSON.stringify([entry.ownerKey, entry.bookId, entry.roundNumber]) !== identity
  ));
  next.unshift({
    ownerKey,
    bookId,
    roundNumber,
    sessionIds: normalizeSessionIds([
      ...(existing?.sessionIds ?? []),
      ...normalizedSessionIds,
    ]),
    hiddenAt,
  });
  try {
    storage.setItem(READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY, JSON.stringify({
      version: STORAGE_VERSION,
      entries: capEntries(next),
    }));
    return true;
  } catch {
    return false;
  }
};
