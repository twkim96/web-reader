import { initDB } from './localDB';
import {
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
  V13_READING_STATISTICS_LEASES_STORE,
  readingStatisticsArchiveKey,
  readingStatisticsDayBaselineKey,
  readingStatisticsDayStorageKey,
  readingStatisticsRecentKey,
} from './localDBSchema';
import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import { trackLocalCommit } from './localCommitTracker';
import { canMergeLocalReadingWithPublication } from './readingRollupCalendar';
import {
  compareReadingSessionIds,
  createReadingRoundCompletionSession,
  isReadingSessionV1,
  sameReadingSessionPayload,
  toReadingSessionPayload,
  type ReadingSessionV1,
  type StoredReadingSessionV11,
} from './readingStatistics';
import {
  compareReadingUploadTimes, isReadingUploadTime, parseReadingRollupArchive,
  readReadingRollupCheckpoint, selectReadingRollupTail, type ReadingRollupArchive, type ReadingRollupBootstrap,
  type ReadingRollupCheckpoint, type ReadingUploadTime,
} from './readingRollupBootstrap';
import { notifyReadingStatisticsChange } from './readingStatisticsWake';
import { readingDayBucketFromSessionId, readingDayReadsEnabled, readingDayWritesEnabled, type ReadingDayEntry } from './readingStatisticsDay';
import type { ReadingDayReceiveCursor } from './readingStatisticsDaySync';
import type {
  ReadingStatisticsSyncLeaseClaimV13,
  ReadingStatisticsSyncLeaseV13,
} from './readingStatisticsSyncLease';

const toStoredSession = (
  ownerKey: OwnerKey,
  session: ReadingSessionV1,
  syncState: StoredReadingSessionV11['syncState'],
): StoredReadingSessionV11 => ({
  ...toReadingSessionPayload(session),
  ownerKey,
  syncState,
  retryCount: 0,
  nextAttemptAt: 0,
  lastErrorCode: null,
});

const readStoredSession = (value: unknown): StoredReadingSessionV11 | null => {
  if (
    typeof value !== 'object'
    || value === null
    || !('ownerKey' in value)
    || typeof value.ownerKey !== 'string'
    || !('syncState' in value)
    || (value.syncState !== 'pending' && value.syncState !== 'synced')
    || !('retryCount' in value)
    || !Number.isSafeInteger(value.retryCount)
    || Number(value.retryCount) < 0
    || !('nextAttemptAt' in value)
    || !Number.isSafeInteger(value.nextAttemptAt)
    || Number(value.nextAttemptAt) < 0
    || !('lastErrorCode' in value)
    || (value.lastErrorCode !== null && typeof value.lastErrorCode !== 'string')
    || !isReadingSessionV1(value)
  ) return null;
  return value as StoredReadingSessionV11;
};

const assertStoredSession = (value: unknown): StoredReadingSessionV11 => {
  const session = readStoredSession(value);
  if (!session) throw new Error('로컬 독서 통계 session이 손상되었습니다.');
  return session;
};

const readingSessionStorageKey = (ownerKey: OwnerKey, sessionId: string) => (
  !isGuestOwner(ownerKey) && readingDayBucketFromSessionId(sessionId) ? readingStatisticsDayStorageKey(ownerKey) : ownerKey
);

type ReadingDayLocalState = {
  floor: ReadingUploadTime;
  publication?: ReadingRollupCheckpoint;
  cursor: ReadingDayReceiveCursor | null;
  completed: boolean;
  quarantinedParts: string[];
  legacyCursor: ReadingStatisticsRemoteCursorV12 | null;
  legacyCompleted: boolean;
  receiptCount: number;
  ready: boolean;
};

const readDayState = (row: unknown): ReadingDayLocalState | null => {
  const value = row as Partial<ReadingDayLocalState> | undefined;
  if (!value || !isReadingUploadTime(value.floor) || typeof value.completed !== 'boolean'
    || (value.publication && !readReadingRollupCheckpoint(value.publication))
    || (value.cursor !== null && (!value.cursor || !isReadingUploadTime(value.cursor.updated) || typeof value.cursor.id !== 'string'))
    || (value.legacyCursor !== null && !readRemoteCursor(value.legacyCursor))
    || typeof value.legacyCompleted !== 'boolean' || typeof value.ready !== 'boolean'
    || !Number.isSafeInteger(value.receiptCount) || Number(value.receiptCount) < 0
    || !Array.isArray(value.quarantinedParts) || !value.quarantinedParts.every((id) => typeof id === 'string')) return null;
  return value as ReadingDayLocalState;
};

export type ReadingStatisticsRemoteCursorV12 = {
  uploadedAtServerSeconds: number;
  uploadedAtServerNanoseconds: number;
  documentId: string;
};

export type QuarantinedReadingStatisticsDocumentV12 = {
  documentId: string;
  reason: string;
  detectedAt: number;
};

type ReadingStatisticsSyncMetaV12 = ReadingStatisticsRemoteCursorV12 & {
  ownerKey: OwnerKey;
  cursorVersion: 0 | 1;
  fullHydrationCompleted: boolean;
  hydratedRemoteCount: number;
  lastFullAuditAt: number;
  lastVerifiedAuditAt: number;
  lastPublishedAuditAt: number;
  fullAuditInProgress: boolean;
  quarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[];
  hydrationRunCount: number;
  hydrationPageCount: number;
  hydrationRemoteReadAttemptCount: number;
  hydrationRemoteReadCount: number;
  hydrationLostLeadershipRunCount: number;
  hydrationFailedRunCount: number;
  lastHydrationDurationMs: number;
  lastHydrationCompletedAt: number;
  published?: ReadingRollupCheckpoint;
  archivedCursor?: ReadingStatisticsRemoteCursorV12;
};

const HYDRATION_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const FULL_HYDRATION_AUDIT_INTERVAL_MS = 4 * HYDRATION_AUDIT_INTERVAL_MS;
export const MAX_QUARANTINED_READING_STATISTICS_DOCUMENTS = 100;
const MAX_WEEKLY_QUARANTINE_PROBES = 8;
// Firestore document IDs may be much longer than our 128-character session
// IDs. A malformed remote document must still remain usable as an exact query
// cursor so hydration can advance past it.
const MAX_REMOTE_DOCUMENT_ID_LENGTH = 1_500;

const readRemoteCursor = (value: unknown): ReadingStatisticsRemoteCursorV12 | null => {
  if (
    typeof value !== 'object'
    || value === null
    || !('documentId' in value)
    || typeof value.documentId !== 'string'
    || value.documentId.length === 0
    || value.documentId.length > MAX_REMOTE_DOCUMENT_ID_LENGTH
  ) return null;
  if (
    'uploadedAtServerSeconds' in value
    && Number.isSafeInteger(value.uploadedAtServerSeconds)
    && Number(value.uploadedAtServerSeconds) >= 0
    && 'uploadedAtServerNanoseconds' in value
    && Number.isInteger(value.uploadedAtServerNanoseconds)
    && Number(value.uploadedAtServerNanoseconds) >= 0
    && Number(value.uploadedAtServerNanoseconds) < 1_000_000_000
  ) {
    return {
      uploadedAtServerSeconds: Number(value.uploadedAtServerSeconds),
      uploadedAtServerNanoseconds: Number(value.uploadedAtServerNanoseconds),
      documentId: value.documentId,
    };
  }
  // Migrate the unreleased millisecond cursor shape without discarding the
  // user's already-hydrated sessions. New writes always preserve nanoseconds.
  if (
    'uploadedAtServerMs' in value
    && Number.isSafeInteger(value.uploadedAtServerMs)
    && Number(value.uploadedAtServerMs) >= 0
  ) {
    const milliseconds = Number(value.uploadedAtServerMs);
    return {
      uploadedAtServerSeconds: Math.floor(milliseconds / 1_000),
      uploadedAtServerNanoseconds: (milliseconds % 1_000) * 1_000_000,
      documentId: value.documentId,
    };
  }
  return null;
};

const readQuarantinedDocuments = (value: unknown) => (
  Array.isArray(value)
    ? value.filter((candidate): candidate is QuarantinedReadingStatisticsDocumentV12 => (
      typeof candidate === 'object'
      && candidate !== null
      && 'documentId' in candidate
      && typeof candidate.documentId === 'string'
      && candidate.documentId.length > 0
      && candidate.documentId.length <= MAX_REMOTE_DOCUMENT_ID_LENGTH
      && 'reason' in candidate
      && typeof candidate.reason === 'string'
      && candidate.reason.length > 0
      && candidate.reason.length <= 240
      && 'detectedAt' in candidate
      && Number.isSafeInteger(candidate.detectedAt)
      && Number(candidate.detectedAt) >= 0
    ))
    : []
);

const assertSyncMeta = (value: unknown): ReadingStatisticsSyncMetaV12 => {
  const cursor = readRemoteCursor(value);
  if (
    !cursor
    || typeof value !== 'object'
    || value === null
    || !('ownerKey' in value)
    || typeof value.ownerKey !== 'string'
    || !('fullHydrationCompleted' in value)
    || typeof value.fullHydrationCompleted !== 'boolean'
    || !('hydratedRemoteCount' in value)
    || !Number.isSafeInteger(value.hydratedRemoteCount)
    || Number(value.hydratedRemoteCount) < 0
  ) throw new Error('독서 통계 hydration cursor가 손상되었습니다.');
  const published = 'published' in value ? readReadingRollupCheckpoint(value.published) : null;
  const archivedCursor = 'archivedCursor' in value ? readRemoteCursor(value.archivedCursor) : null;
  return {
    ...cursor,
    ownerKey: value.ownerKey as OwnerKey,
    cursorVersion: 'cursorVersion' in value && value.cursorVersion === 1 ? 1 : 0,
    fullHydrationCompleted: value.fullHydrationCompleted,
    hydratedRemoteCount: Number(value.hydratedRemoteCount),
    lastFullAuditAt: 'lastFullAuditAt' in value
      && Number.isSafeInteger(value.lastFullAuditAt)
      && Number(value.lastFullAuditAt) >= 0
      ? Number(value.lastFullAuditAt)
      : 0,
    lastVerifiedAuditAt: 'lastVerifiedAuditAt' in value
      && Number.isSafeInteger(value.lastVerifiedAuditAt)
      && Number(value.lastVerifiedAuditAt) >= 0
      ? Number(value.lastVerifiedAuditAt)
      : 0,
    lastPublishedAuditAt: 'lastPublishedAuditAt' in value
      && Number.isSafeInteger(value.lastPublishedAuditAt) && Number(value.lastPublishedAuditAt) >= 0
      ? Number(value.lastPublishedAuditAt) : 0,
    fullAuditInProgress: 'fullAuditInProgress' in value
      && value.fullAuditInProgress === true,
    quarantinedDocuments: 'quarantinedDocuments' in value
      ? readQuarantinedDocuments(value.quarantinedDocuments).slice(-MAX_QUARANTINED_READING_STATISTICS_DOCUMENTS)
      : [],
    hydrationRunCount: 'hydrationRunCount' in value
      && Number.isSafeInteger(value.hydrationRunCount)
      && Number(value.hydrationRunCount) >= 0
      ? Number(value.hydrationRunCount)
      : 0,
    hydrationPageCount: 'hydrationPageCount' in value
      && Number.isSafeInteger(value.hydrationPageCount)
      && Number(value.hydrationPageCount) >= 0
      ? Number(value.hydrationPageCount)
      : 0,
    hydrationRemoteReadAttemptCount: 'hydrationRemoteReadAttemptCount' in value
      && Number.isSafeInteger(value.hydrationRemoteReadAttemptCount)
      && Number(value.hydrationRemoteReadAttemptCount) >= 0
      ? Number(value.hydrationRemoteReadAttemptCount)
      : 0,
    hydrationRemoteReadCount: 'hydrationRemoteReadCount' in value
      && Number.isSafeInteger(value.hydrationRemoteReadCount)
      && Number(value.hydrationRemoteReadCount) >= 0
      ? Number(value.hydrationRemoteReadCount)
      : 0,
    hydrationLostLeadershipRunCount: 'hydrationLostLeadershipRunCount' in value
      && Number.isSafeInteger(value.hydrationLostLeadershipRunCount)
      && Number(value.hydrationLostLeadershipRunCount) >= 0
      ? Number(value.hydrationLostLeadershipRunCount)
      : 0,
    hydrationFailedRunCount: 'hydrationFailedRunCount' in value
      && Number.isSafeInteger(value.hydrationFailedRunCount)
      && Number(value.hydrationFailedRunCount) >= 0
      ? Number(value.hydrationFailedRunCount)
      : 0,
    lastHydrationDurationMs: 'lastHydrationDurationMs' in value
      && Number.isFinite(value.lastHydrationDurationMs)
      && Number(value.lastHydrationDurationMs) >= 0
      ? Number(value.lastHydrationDurationMs)
      : 0,
    lastHydrationCompletedAt: 'lastHydrationCompletedAt' in value
      && Number.isSafeInteger(value.lastHydrationCompletedAt)
      && Number(value.lastHydrationCompletedAt) >= 0
      ? Number(value.lastHydrationCompletedAt)
      : 0,
    ...(published ? { published } : {}),
    ...(published && archivedCursor && sameCursor(cursor, archivedCursor) ? { archivedCursor } : {}),
  };
};

const sameCursor = (
  left: ReadingStatisticsRemoteCursorV12,
  right: ReadingStatisticsRemoteCursorV12,
) => left.uploadedAtServerSeconds === right.uploadedAtServerSeconds
  && left.uploadedAtServerNanoseconds === right.uploadedAtServerNanoseconds
  && left.documentId === right.documentId;

const createEmptySyncMeta = (ownerKey: OwnerKey): ReadingStatisticsSyncMetaV12 => ({
  ownerKey,
  cursorVersion: 1,
  uploadedAtServerSeconds: 0,
  uploadedAtServerNanoseconds: 0,
  documentId: '__empty__',
  fullHydrationCompleted: false,
  hydratedRemoteCount: 0,
  lastFullAuditAt: 0,
  lastVerifiedAuditAt: 0,
  lastPublishedAuditAt: 0,
  fullAuditInProgress: true,
  quarantinedDocuments: [],
  hydrationRunCount: 0,
  hydrationPageCount: 0,
  hydrationRemoteReadAttemptCount: 0,
  hydrationRemoteReadCount: 0,
  hydrationLostLeadershipRunCount: 0,
  hydrationFailedRunCount: 0,
  lastHydrationDurationMs: 0,
  lastHydrationCompletedAt: 0,
});

type PublishedStoredSession = StoredReadingSessionV11 & {
  receivedWithPublication?: true;
  tailReceivedAt?: ReadingUploadTime;
  tailAdmitted?: boolean;
};
const hasPublicationReceipt = (session: PublishedStoredSession | null) => session?.receivedWithPublication === true;
const hasPublishedCursor = (meta: ReadingStatisticsSyncMetaV12, received: readonly (StoredReadingSessionV11 | null)[]) =>
  meta.documentId === '__empty__' || Boolean(meta.archivedCursor) || received.some((row) => row?.sessionId === meta.documentId);

const samePublishedReading = (left: ReadingRollupCheckpoint, right: ReadingRollupCheckpoint) =>
  left.firstDay === right.firstDay && left.lastDay === right.lastDay
  && compareReadingUploadTimes(left.sourceThrough, right.sourceThrough) === 0
  && left.sampleFloor === right.sampleFloor;

const sameDayPublication = (left?: ReadingRollupCheckpoint, right?: ReadingRollupCheckpoint) =>
  left && right ? samePublishedReading(left, right) : left === right;

const dayBaselineIds = (value: unknown, publication?: ReadingRollupCheckpoint) => {
  const baseline = value as { publication?: ReadingRollupCheckpoint; carrySessionIds?: unknown } | undefined;
  const ids = baseline?.carrySessionIds;
  const saved = baseline?.publication;
  return publication && saved && isReadingUploadTime(saved.sourceThrough) && samePublishedReading(saved, publication)
    && Array.isArray(ids) && ids.every((id) => typeof id === 'string') ? new Set<string>(ids) : undefined;
};

export async function needsReadingDayBaseline(ownerKey: OwnerKey) {
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE]);
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const [meta, baseline] = await Promise.all([metaStore.get(ownerKey), metaStore.get(readingStatisticsDayBaselineKey(ownerKey))]);
  const publication = meta && assertSyncMeta(meta).published;
  if (!publication) return false;
  const ids = dayBaselineIds(baseline, publication);
  if (!ids) return true;
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  return (await Promise.all([...ids].map((id) => store.getKey([ownerKey, id])))).some((key) => key === undefined);
}

export async function prepareReadingDayReceive(
  ownerKey: OwnerKey, floor: ReadingUploadTime, publication: ReadingRollupCheckpoint | undefined,
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13, now = Date.now(),
) {
  const storageKey = readingStatisticsDayStorageKey(ownerKey);
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const meta = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  const [previous, leased, rows] = await Promise.all([meta.get(storageKey),
    hasCurrentStatisticsLease(tx.objectStore(V13_READING_STATISTICS_LEASES_STORE), ownerKey, leaseClaim, now),
    store.index('by-owner').getAll(storageKey)]);
  if (!leased) { await tx.done; return null; }
  const saved = readDayState(previous);
  if (saved && sameDayPublication(saved.publication, publication)
    && (publication ? countDayReceipts(rows) === saved.receiptCount
      : compareReadingUploadTimes(saved.cursor?.updated ?? saved.floor, floor) >= 0)) {
    await tx.done;
    return saved;
  }
  if (publication || saved?.publication || rows.some((row) => 'tailReceivedAt' in row)) {
    await Promise.all(rows.map(assertStoredSession)
      .filter(({ syncState }) => syncState === 'synced')
      .map(({ sessionId }) => store.delete([storageKey, sessionId])));
  }
  const next: ReadingDayLocalState = { floor, publication, cursor: null, completed: false, quarantinedParts: [],
    legacyCursor: null, legacyCompleted: false, ready: false, receiptCount: 0 };
  await meta.put({ ...next, ownerKey: storageKey });
  await tx.done;
  if (publication || saved?.publication) notifyReadingStatisticsChange(ownerKey);
  return next;
}

const sameDayCursor = (left: ReadingDayReceiveCursor | null, right: ReadingDayReceiveCursor | null) =>
  left && right ? left.id === right.id && compareReadingUploadTimes(left.updated, right.updated) === 0 : left === right;

const countDayReceipts = (rows: PublishedStoredSession[]) => rows.filter(({ tailReceivedAt }) => isReadingUploadTime(tailReceivedAt)).length;
const sameLegacyTailCursor = (left: ReadingStatisticsRemoteCursorV12 | null, right: ReadingStatisticsRemoteCursorV12 | null) =>
  left && right ? sameCursor(left, right) : left === right;

export async function hydrateReadingDayReceivePage(
  ownerKey: OwnerKey, expected: ReadingDayLocalState,
  page: { entries: ReadingDayEntry[]; done: boolean; quarantinedParts: string[] } & (
    { nextCursor: ReadingDayReceiveCursor | null } | { nextLegacyCursor: ReadingStatisticsRemoteCursorV12 | null }
  ),
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13, now = Date.now(),
) {
  const storageKey = readingStatisticsDayStorageKey(ownerKey);
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  const meta = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  try {
    const [raw, leased] = await Promise.all([meta.get(storageKey),
      hasCurrentStatisticsLease(tx.objectStore(V13_READING_STATISTICS_LEASES_STORE), ownerKey, leaseClaim, now)]);
    const state = readDayState(raw);
    if (!leased || !state || compareReadingUploadTimes(state.floor, expected.floor) !== 0
      || !sameDayPublication(state.publication, expected.publication) || !sameDayCursor(state.cursor, expected.cursor)
      || !sameLegacyTailCursor(state.legacyCursor, expected.legacyCursor) || state.receiptCount !== expected.receiptCount) {
      await tx.done;
      return null;
    }
    let receiptCount = state.receiptCount;
    for (const { session, firstReceivedAt } of page.entries) {
      const key = [storageKey, session.sessionId];
      const existing = await store.get(key) as PublishedStoredSession | undefined;
      if (state.publication && existing?.tailReceivedAt) {
        if (!sameReadingSessionPayload(existing, session)
          || compareReadingUploadTimes(existing.tailReceivedAt, firstReceivedAt) !== 0) {
          throw new Error('독서 통계 원본 수신 기록이 충돌했습니다.');
        }
        continue;
      }
      if (state.publication) receiptCount++;
      await store.put({
        ...toStoredSession(ownerKey, session, 'synced'), ownerKey: storageKey,
        ...(state.publication && { tailReceivedAt: firstReceivedAt, tailAdmitted: false }),
      });
      if ('nextLegacyCursor' in page) {
        const previous = readStoredSession(await store.get([ownerKey, session.sessionId]));
        if (previous?.syncState === 'pending') await store.put(toStoredSession(ownerKey, session, 'synced'));
      }
    }
    const next: ReadingDayLocalState = {
      ...state, receiptCount, ready: state.ready && receiptCount === state.receiptCount,
      ...('nextLegacyCursor' in page ? { legacyCursor: page.nextLegacyCursor, legacyCompleted: page.done }
        : { cursor: page.nextCursor, completed: page.done }),
      quarantinedParts: [...new Set([...state.quarantinedParts, ...page.quarantinedParts])].slice(-MAX_QUARANTINED_READING_STATISTICS_DOCUMENTS),
    };
    await meta.put({ ...next, ownerKey: storageKey });
    await tx.done;
    if (!state.publication && (page.entries.length || page.done && !state.completed)) notifyReadingStatisticsChange(ownerKey);
    return next;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already have been aborted. */ }
    throw error;
  }
}

export async function finalizeReadingDayTail(
  ownerKey: OwnerKey, publication: ReadingRollupCheckpoint, leaseClaim: ReadingStatisticsSyncLeaseClaimV13, now = Date.now(),
) {
  const db = await initDB();
  const key = readingStatisticsDayStorageKey(ownerKey);
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  const meta = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const [stateRow, archive, current, leased, legacy, days] = await Promise.all([
    meta.get(key), meta.get(readingStatisticsDayBaselineKey(ownerKey)), meta.get(ownerKey),
    hasCurrentStatisticsLease(tx.objectStore(V13_READING_STATISTICS_LEASES_STORE), ownerKey, leaseClaim, now),
    store.index('by-owner').getAll(ownerKey), store.index('by-owner').getAll(key),
  ]);
  const state = readDayState(stateRow);
  const currentPublication = current && assertSyncMeta(current).published;
  const baseline = dayBaselineIds(archive, currentPublication);
  const carry = baseline ? legacy.filter((row) => baseline.has(row.sessionId)) : [];
  if (!leased || !state?.completed || !state.legacyCompleted || !sameDayPublication(state.publication, publication)
    || !sameDayPublication(currentPublication, publication)
    || !baseline || carry.length !== baseline.size || state.receiptCount !== countDayReceipts(days)) {
    await tx.done;
    return false;
  }
  if (!state.ready) {
    const received = (days as PublishedStoredSession[]).filter((row) => row.tailReceivedAt && !baseline.has(row.sessionId));
    // UTF-8 lexicographic order is the same as Unicode code point order.
    received.sort((a, b) => compareReadingUploadTimes(a.tailReceivedAt!, b.tailReceivedAt!)
      || compareReadingSessionIds(a.sessionId, b.sessionId));
    const accepted = new Set(selectReadingRollupTail(publication, carry, received).map(({ sessionId }) => sessionId));
    for (const row of received) {
      const tailAdmitted = accepted.has(row.sessionId);
      if (row.tailAdmitted !== tailAdmitted) await store.put({ ...row, tailAdmitted });
    }
    await meta.put({ ...state, ownerKey: key, ready: true });
  }
  await tx.done;
  if (!state.ready) notifyReadingStatisticsChange(ownerKey);
  return true;
}

export async function installReadingStatisticsBootstrap(
  ownerKey: OwnerKey,
  bootstrap: ReadingRollupBootstrap,
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13,
  now = Date.now(),
  previous?: ReadingRollupCheckpoint,
  replaceRawCheckpoint = false,
) {
  if (isGuestOwner(ownerKey)) return false;
  const { carry, ...archive } = bootstrap;
  const published: ReadingRollupCheckpoint = {
    firstDay: archive.calendar.firstDay, lastDay: archive.calendar.lastDay,
    sourceThrough: archive.sourceThrough, sampleFloor: carry.sampleFloor, checkedAt: now,
  };
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const sessionsStore = tx.objectStore(V11_READING_SESSIONS_STORE);
  const recentKey = readingStatisticsRecentKey(ownerKey);
  const archiveKey = readingStatisticsArchiveKey(ownerKey);
  const [value, recentRow, leased] = await Promise.all([
    metaStore.get(ownerKey), metaStore.get(recentKey),
    hasCurrentStatisticsLease(tx.objectStore(V13_READING_STATISTICS_LEASES_STORE), ownerKey, leaseClaim, now),
  ]);
  const current = value ? assertSyncMeta(value) : createEmptySyncMeta(ownerKey);
  const canInstall = recentRow || (!current.published && replaceRawCheckpoint) || (previous
    ? current.published && !current.fullAuditInProgress && samePublishedReading(previous, current.published)
    : !current.published && current.documentId === '__empty__' && !current.fullHydrationCompleted && current.lastFullAuditAt === 0);
  if (!leased || !canInstall || current.ownerKey !== ownerKey) {
    await tx.done;
    return false;
  }
  // A legacy tab can replace the owner checkpoint while the archive still backs compacted weeks.
  const saved = current.published ? null : parseReadingRollupArchive((await metaStore.get(archiveKey))?.archive);
  const priorRange = current.published ?? (saved ? { ...saved.calendar, sourceThrough: saved.sourceThrough } : null);
  const localRows = await sessionsStore.index('by-owner').getAll(ownerKey);
  const locals = new Map(localRows.map((row) => {
    const session = assertStoredSession(row);
    return [session.sessionId, session];
  }));
  const carryIds = new Set(carry.sessions.map(({ sessionId }) => sessionId));
  const sameBoundary = previous && samePublishedReading(previous, published);
  const trusted = [...locals.values()].filter((row) => sameBoundary && hasPublicationReceipt(row) && !carryIds.has(row.sessionId));
  const trustedIds = new Set([...carryIds, ...trusted.map(({ sessionId }) => sessionId)]);
  if ((!previous && !recentRow && !replaceRawCheckpoint && [...locals.values()].some(({ syncState }) => syncState === 'synced'))
    || (priorRange && (published.firstDay > priorRange.firstDay || published.lastDay < priorRange.lastDay
      || compareReadingUploadTimes(published.sourceThrough, priorRange.sourceThrough) < 0))
    || carry.sessions.some((session) => {
      const row = locals.get(session.sessionId);
      return row && !sameReadingSessionPayload(row, session);
    })) {
    await tx.done;
    return false;
  }
  // Replayed tail rows must satisfy the new closing boundary.
  const keepCursor = sameBoundary && current.documentId !== '__empty__';
  let archivedCursor = keepCursor ? current.archivedCursor : undefined;
  const compactWrites: Promise<unknown>[] = [];
  for (const row of locals.values()) {
    if (row.syncState === 'synced' && !trustedIds.has(row.sessionId)) {
      compactWrites.push(sessionsStore.delete([ownerKey, row.sessionId]));
      locals.delete(row.sessionId);
      if (keepCursor && current.documentId === row.sessionId) archivedCursor = readRemoteCursor(current) ?? undefined;
    }
  }
  await Promise.all(compactWrites);
  for (const session of carry.sessions) {
    const row = locals.get(session.sessionId);
    if (row?.syncState === 'synced' && hasPublicationReceipt(row)) continue;
    const stored = { ...toStoredSession(ownerKey, session, 'synced'), receivedWithPublication: true } as const;
    await sessionsStore.put(stored);
    locals.set(session.sessionId, stored);
  }
  const empty = createEmptySyncMeta(ownerKey);
  await metaStore.put({
    ...current, cursorVersion: 1,
    uploadedAtServerSeconds: keepCursor ? current.uploadedAtServerSeconds : empty.uploadedAtServerSeconds,
    uploadedAtServerNanoseconds: keepCursor ? current.uploadedAtServerNanoseconds : empty.uploadedAtServerNanoseconds,
    documentId: keepCursor ? current.documentId : empty.documentId,
    fullHydrationCompleted: Boolean(sameBoundary && current.fullHydrationCompleted),
    fullAuditInProgress: false, published,
    archivedCursor,
    lastFullAuditAt: 0,
    quarantinedDocuments: keepCursor ? current.quarantinedDocuments : [],
    hydratedRemoteCount: [...locals.values()].filter(hasPublicationReceipt).length,
  } satisfies ReadingStatisticsSyncMetaV12);
  await metaStore.put({ ownerKey: archiveKey, archive });
  await metaStore.put({ ownerKey: readingStatisticsDayBaselineKey(ownerKey), publication: published, carrySessionIds: [...carryIds] });
  if (recentRow) await metaStore.delete(recentKey);
  await tx.done;
  notifyReadingStatisticsChange(ownerKey);
  return true;
}

export async function beginReadingStatisticsRecentRecovery(
  ownerKey: OwnerKey, leaseClaim: ReadingStatisticsSyncLeaseClaimV13, now = Date.now(),
) {
  const db = await initDB();
  const tx = db.transaction([V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  const store = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const key = readingStatisticsRecentKey(ownerKey);
  const [saved, leased] = await Promise.all([
    store.get(key),
    hasCurrentStatisticsLease(tx.objectStore(V13_READING_STATISTICS_LEASES_STORE), ownerKey, leaseClaim, now),
  ]);
  if (leased && !saved) await store.put({ ownerKey: key, state: createEmptySyncMeta(ownerKey) });
  await tx.done;
  if (leased && !saved) notifyReadingStatisticsChange(ownerKey);
  return leased;
}

export type LocalReadingRollupArchive = ReadingRollupArchive
  | (Pick<ReadingRollupArchive, 'calendar' | 'sourceThrough'> & { recentOnly: true })
  | 'unavailable' | null;

export async function getLocalReadingRollupArchive(ownerKey: OwnerKey, previous?: LocalReadingRollupArchive): Promise<LocalReadingRollupArchive> {
  const db = await initDB();
  const tx = db.transaction(V12_READING_STATISTICS_SYNC_STORE);
  const [value, recentRow] = await Promise.all([tx.store.get(ownerKey), tx.store.get(readingStatisticsRecentKey(ownerKey))]);
  const point = value ? assertSyncMeta(value).published : undefined;
  const key = readingStatisticsArchiveKey(ownerKey);
  const saved = point ? await tx.store.get(key) : await tx.store.getKey(key);
  await tx.done;
  if (!point) return saved || recentRow ? 'unavailable' : null;
  const archive = localArchiveForCheckpoint(saved?.archive, point);
  if (!archive) return 'unavailable';
  if (recentRow) {
    return previous && previous !== 'unavailable' && 'recentOnly' in previous && sameArchiveRange(previous, point)
      ? previous : { calendar: archive.calendar, sourceThrough: archive.sourceThrough, recentOnly: true };
  }
  return previous && previous !== 'unavailable'
    && !('recentOnly' in previous)
    && sameArchiveRange(previous, { ...archive.calendar, sourceThrough: archive.sourceThrough }) ? previous : archive;
}

function sameArchiveRange(archive: Pick<ReadingRollupArchive, 'calendar' | 'sourceThrough'>, range: Pick<ReadingRollupCheckpoint, 'firstDay' | 'lastDay' | 'sourceThrough'>) {
  return archive.calendar.firstDay === range.firstDay && archive.calendar.lastDay === range.lastDay
    && compareReadingUploadTimes(archive.sourceThrough, range.sourceThrough) === 0;
}

function localArchiveForCheckpoint(value: unknown, point?: ReadingRollupCheckpoint) {
  const archive = point && parseReadingRollupArchive(value);
  return archive && point && sameArchiveRange(archive, point) ? archive : null;
}

const isCurrentStatisticsLease = (
  value: unknown,
  claim: ReadingStatisticsSyncLeaseClaimV13,
  now: number,
) => {
  const lease = value as ReadingStatisticsSyncLeaseV13 | undefined;
  return Boolean(
    lease
    && lease.holderTabId === claim.holderTabId
    && lease.epoch === claim.epoch
    && lease.expiresAt > now,
  );
};

const hasCurrentStatisticsLease = async (
  store: { get: (key: OwnerKey) => Promise<unknown> },
  ownerKey: OwnerKey,
  claim: ReadingStatisticsSyncLeaseClaimV13,
  now: number,
) => isCurrentStatisticsLease(await store.get(ownerKey), claim, now);

const putReadingSession = async (
  ownerKey: OwnerKey,
  session: ReadingSessionV1,
  source: 'local' | 'remote',
) => {
  if (!isReadingSessionV1(session)) throw new Error('독서 통계 session schema가 올바르지 않습니다.');
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  const storageKey = readingSessionStorageKey(ownerKey, session.sessionId);
  const existingValue = await store.get([storageKey, session.sessionId]);
  if (existingValue) {
    const existing = assertStoredSession(existingValue);
    if (!sameReadingSessionPayload(existing, session)) {
      tx.abort();
      throw new Error('독서 통계 session ID가 다른 내용과 충돌했습니다.');
    }
    if (source === 'remote' && existing.syncState !== 'synced') {
      await store.put({
        ...existing,
        syncState: 'synced',
        retryCount: 0,
        nextAttemptAt: 0,
        lastErrorCode: null,
      });
    }
  } else {
    await store.add({ ...toStoredSession(
      ownerKey,
      session,
      source === 'remote' || isGuestOwner(ownerKey) ? 'synced' : 'pending',
    ), ownerKey: storageKey });
  }
  await tx.done;
  notifyReadingStatisticsChange(ownerKey);
};

export const saveLocalReadingSessionV11 = (
  ownerKey: OwnerKey,
  session: ReadingSessionV1,
) => trackLocalCommit(putReadingSession(ownerKey, session, 'local'));

export const confirmLocalReadingRoundV11 = (
  ownerKey: OwnerKey,
  bookId: string,
  expectedRoundNumber: number,
  confirmedAtClient = Date.now(),
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  const values = await store.index('by-owner-book').getAll([ownerKey, bookId]);
  const sessions = values.map(assertStoredSession);
  const result = createReadingRoundCompletionSession({
    sessions,
    bookId,
    expectedRoundNumber,
    sessionId: crypto.randomUUID(),
    confirmedAtClient,
  });
  if (result.status !== 'created') {
    await tx.done;
    return result;
  }
  await store.add(toStoredSession(
    ownerKey,
    result.session,
    isGuestOwner(ownerKey) ? 'synced' : 'pending',
  ));
  await tx.done;
  notifyReadingStatisticsChange(ownerKey);
  return result;
})());

type ReadingStatisticsAuditCandidateV12 = {
  cursor: ReadingStatisticsRemoteCursorV12;
  remoteCount: number;
  quarantinedDocumentIds: string[];
  lastFullAuditAt: number;
  lastVerifiedAuditAt: number;
  publishedAudit?: true;
};

export type ReadingStatisticsFullScanReason =
  | 'initial-history'
  | 'empty-history'
  | 'local-history-missing'
  | 'periodic-full-audit'
  | 'quarantined-history'
  | 'local-synced-count-ahead'
  | 'local-synced-count-behind'
  | 'local-cursor-invalid'
  | 'legacy-cursor'
  | 'weekly-audit-unavailable'
  | 'remote-audit-mismatch'
  | 'remote-audit-failed'
  | 'audit-checkpoint-changed'
  | 'published-history-unavailable';

type LocalFullScan = { reason: ReadingStatisticsFullScanReason; catchUpFrom?: ReadingStatisticsAuditCandidateV12 };
type ReadingStatisticsHydrationStateV12 = {
  cursor: ReadingStatisticsRemoteCursorV12 | null;
  fullHydrationCompleted: boolean;
  quarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[];
  lastFullAuditAt: number;
};
type ReadingStatisticsHydrationPlanV12 =
  | { state: ReadingStatisticsHydrationStateV12; fullAuditInProgress: boolean; reason?: 'empty-history' | 'initial-history'; published?: ReadingRollupCheckpoint; recentOnly?: true }
  | { candidate: ReadingStatisticsAuditCandidateV12 }
  | { reason: 'legacy-cursor'; legacyCursor: ReadingStatisticsRemoteCursorV12 }
  | LocalFullScan;

const getAuditCandidate = async (
  sessions: { index: (name: string) => { count: (range: IDBKeyRange) => Promise<number> }; get: (key: [OwnerKey, string]) => Promise<unknown> },
  ownerKey: OwnerKey,
  meta: ReadingStatisticsSyncMetaV12,
  now: number,
  publishedAudit = false,
  boundedRawAudit = false,
): Promise<{ candidate: ReadingStatisticsAuditCandidateV12 } | LocalFullScan> => {
  if (meta.documentId === '__empty__') return { reason: 'empty-history' };
  if (isGuestOwner(ownerKey) || meta.ownerKey !== ownerKey || !meta.cursorVersion
    || !meta.fullHydrationCompleted || meta.fullAuditInProgress
    || meta.lastFullAuditAt === 0 || (publishedAudit
      ? (meta.lastPublishedAuditAt > 0 && now - meta.lastPublishedAuditAt < HYDRATION_AUDIT_INTERVAL_MS)
      : (!boundedRawAudit && now - meta.lastFullAuditAt >= FULL_HYDRATION_AUDIT_INTERVAL_MS)
        || now - Math.max(meta.lastFullAuditAt, meta.lastVerifiedAuditAt) < HYDRATION_AUDIT_INTERVAL_MS)) {
    return { reason: 'weekly-audit-unavailable' };
  }
  const quarantinedDocumentIds = meta.quarantinedDocuments.map(({ documentId }) => documentId).sort();
  if ((publishedAudit && quarantinedDocumentIds.length > 0) || quarantinedDocumentIds.length > MAX_WEEKLY_QUARANTINE_PROBES
    || new Set(quarantinedDocumentIds).size !== quarantinedDocumentIds.length) return { reason: 'quarantined-history' };
  const [syncedCount, latest, ...quarantinedRows] = await Promise.all([
    sessions.index('by-owner-sync-next-attempt').count(IDBKeyRange.bound(
      [ownerKey, 'synced', 0], [ownerKey, 'synced', Number.MAX_SAFE_INTEGER],
    )),
    sessions.get([ownerKey, meta.documentId]),
    ...quarantinedDocumentIds.map((id) => sessions.get([ownerKey, id])),
  ]);
  // A document cannot stand in for both a received session and a quarantine entry.
  if (quarantinedRows.some((row) => row !== undefined)) return { reason: 'quarantined-history' };
  if (syncedCount < meta.hydratedRemoteCount) return { reason: 'local-synced-count-behind' };
  const remoteCount = meta.hydratedRemoteCount + quarantinedDocumentIds.length;
  if (remoteCount === 0) return { reason: 'weekly-audit-unavailable' };
  if (!quarantinedDocumentIds.includes(meta.documentId) && readStoredSession(latest)?.syncState !== 'synced') {
    return { reason: 'local-cursor-invalid' };
  }
  const { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId } = meta;
  const candidate = {
    cursor: { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId },
    remoteCount,
    quarantinedDocumentIds,
    lastFullAuditAt: meta.lastFullAuditAt,
    lastVerifiedAuditAt: meta.lastVerifiedAuditAt,
    ...(publishedAudit ? { publishedAudit: true as const } : {}),
  };
  if (syncedCount > meta.hydratedRemoteCount) return { reason: 'local-synced-count-ahead', catchUpFrom: candidate };
  return { candidate };
};

export const getReadingStatisticsHydrationPlanV12 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
  allowPublishedAudit = false,
  boundedRawAudit = false,
): Promise<ReadingStatisticsHydrationPlanV12> => {
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE]);
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const [value, recentRow] = await Promise.all([metaStore.get(ownerKey), metaStore.get(readingStatisticsRecentKey(ownerKey))]);
  if (recentRow) {
    await tx.done;
    const recent = assertSyncMeta(recentRow.state);
    return { recentOnly: true, fullAuditInProgress: false, state: {
      cursor: recent.documentId === '__empty__' ? null : readRemoteCursor(recent),
      fullHydrationCompleted: false, lastFullAuditAt: 0, quarantinedDocuments: recent.quarantinedDocuments,
    } };
  }
  const meta = value ? assertSyncMeta(value) : null;
  const archiveKey = readingStatisticsArchiveKey(ownerKey);
  if (!meta?.published && await metaStore.getKey(archiveKey)) {
    await tx.done;
    return { reason: 'published-history-unavailable' };
  }
  if (!meta) {
    await tx.done;
    return { reason: 'initial-history' };
  }
  if (meta.ownerKey !== ownerKey) throw new Error('독서 통계 hydration owner가 올바르지 않습니다.');
  const sessions = tx.objectStore(V11_READING_SESSIONS_STORE);
  if (meta.published) {
    const cursor = meta.documentId === '__empty__' ? null : readRemoteCursor(meta);
    const state = { cursor, fullHydrationCompleted: meta.fullHydrationCompleted,
      lastFullAuditAt: meta.lastFullAuditAt, quarantinedDocuments: meta.quarantinedDocuments };
    if (meta.fullAuditInProgress) {
      await tx.done;
      return { state, fullAuditInProgress: true };
    }
    if (!allowPublishedAudit) {
      await tx.done;
      return { reason: 'published-history-unavailable' };
    }
    const [stored, rows] = await Promise.all([
      metaStore.get(archiveKey),
      sessions.index('by-owner').getAll(ownerKey),
    ]);
    await tx.done;
    const received = rows.map(readStoredSession).filter((row) => row?.syncState === 'synced' && hasPublicationReceipt(row));
    if (!localArchiveForCheckpoint(stored?.archive, meta.published)
      || received.length !== meta.hydratedRemoteCount
      || !hasPublishedCursor(meta, received)) {
      return { reason: 'published-history-unavailable' };
    }
    return { state, published: meta.published, fullAuditInProgress: false };
  }
  if (!meta.cursorVersion) {
    const { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId } = meta;
    await tx.done;
    // The empty sentinel has no remote marker to verify. Use an authoritative
    // scan before trusting an empty timestamp checkpoint.
    return documentId === '__empty__' ? { reason: 'legacy-cursor' } : {
      reason: 'legacy-cursor',
      legacyCursor: { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId },
    };
  }
  const localCount = await sessions.index('by-owner').count(ownerKey);
  let plan: ReadingStatisticsHydrationPlanV12;
  const dueForFull = !meta.fullAuditInProgress && now - meta.lastFullAuditAt >= FULL_HYDRATION_AUDIT_INTERVAL_MS;
  const publishedAudit = dueForFull && allowPublishedAudit && meta.quarantinedDocuments.length === 0;
  const publishedAuditFresh = publishedAudit && meta.lastPublishedAuditAt > 0
    && now >= meta.lastPublishedAuditAt && now - meta.lastPublishedAuditAt < HYDRATION_AUDIT_INTERVAL_MS;
  if (localCount < meta.hydratedRemoteCount) {
    // A surviving cursor must not hide older records after local data loss.
    plan = { reason: 'local-history-missing' };
  } else if (dueForFull && !publishedAudit && !boundedRawAudit) {
    plan = { reason: 'periodic-full-audit' };
  } else if ((publishedAudit && !publishedAuditFresh) || (!publishedAudit && !meta.fullAuditInProgress
    && now - Math.max(meta.lastFullAuditAt, meta.lastVerifiedAuditAt) >= HYDRATION_AUDIT_INTERVAL_MS)) {
    plan = await getAuditCandidate(sessions, ownerKey, meta, now, publishedAudit, boundedRawAudit);
  } else {
    const { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId, fullHydrationCompleted, quarantinedDocuments, lastFullAuditAt } = meta;
    const cursor = documentId === '__empty__' ? null : { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId };
    plan = {
      state: { cursor, fullHydrationCompleted, quarantinedDocuments, lastFullAuditAt },
      fullAuditInProgress: meta.fullAuditInProgress,
      reason: cursor ? undefined : fullHydrationCompleted ? 'empty-history' : 'initial-history',
    };
  }
  await tx.done;
  return plan;
};

export const getReadingStatisticsHydrationStateV12 = async (ownerKey: OwnerKey, now = Date.now()) => {
  const plan = await getReadingStatisticsHydrationPlanV12(ownerKey, now);
  return 'state' in plan ? plan.state : null;
};

export const adoptLegacyReadingStatisticsCursorV12 = async (
  ownerKey: OwnerKey,
  verifiedCursor: ReadingStatisticsRemoteCursorV12,
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13,
  clock = Date.now,
) => {
  const db = await initDB();
  const tx = db.transaction([V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  const store = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const [value, lease] = await Promise.all([
    store.get(ownerKey),
    tx.objectStore(V13_READING_STATISTICS_LEASES_STORE).get(ownerKey),
  ]);
  const current = value ? assertSyncMeta(value) : null;
  const canAdopt = current?.ownerKey === ownerKey && !current.cursorVersion
    && current.documentId !== '__empty__' && sameCursor(current, verifiedCursor)
    && isCurrentStatisticsLease(lease, leaseClaim, clock());
  if (canAdopt) await store.put({ ...value, cursorVersion: 1 });
  await tx.done;
  return canAdopt;
};

export const recordReadingStatisticsVerifiedAuditV12 = async (
  ownerKey: OwnerKey,
  candidate: ReadingStatisticsAuditCandidateV12,
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13,
  clock = Date.now,
  boundedRawAudit = false,
) => {
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const value = await metaStore.get(ownerKey);
  const check = value ? await getAuditCandidate(
    tx.objectStore(V11_READING_SESSIONS_STORE), ownerKey, assertSyncMeta(value), clock(), candidate.publishedAudit, boundedRawAudit,
  ) : null;
  const current = check && 'candidate' in check ? check.candidate : null;
  const lease = await tx.objectStore(V13_READING_STATISTICS_LEASES_STORE).get(ownerKey);
  const now = clock();
  const canRecord = current && current.remoteCount === candidate.remoteCount
    && current.lastFullAuditAt === candidate.lastFullAuditAt && current.lastVerifiedAuditAt === candidate.lastVerifiedAuditAt
    && sameCursor(current.cursor, candidate.cursor)
    && current.quarantinedDocumentIds.length === candidate.quarantinedDocumentIds.length
    && current.quarantinedDocumentIds.every((id, index) => id === candidate.quarantinedDocumentIds[index])
    && (candidate.publishedAudit || boundedRawAudit || now - current.lastFullAuditAt < FULL_HYDRATION_AUDIT_INTERVAL_MS)
    && isCurrentStatisticsLease(lease, leaseClaim, now);
  if (canRecord) await metaStore.put({ ...assertSyncMeta(value), lastVerifiedAuditAt: now,
    ...(candidate.publishedAudit ? { lastPublishedAuditAt: now } : {}),
  });
  await tx.done;
  return Boolean(canRecord);
};

export const getReadingStatisticsHydrationMetricsV12 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const tx = db.transaction(V12_READING_STATISTICS_SYNC_STORE);
  const [value, recent] = await Promise.all([
    tx.store.get(ownerKey), tx.store.get(readingStatisticsRecentKey(ownerKey)),
  ]);
  await tx.done;
  if (!value && !recent) return null;
  const meta = assertSyncMeta(value ?? recent?.state);
  return {
    runCount: meta.hydrationRunCount,
    pageCount: meta.hydrationPageCount,
    remoteReadAttemptCount: meta.hydrationRemoteReadAttemptCount,
    remoteReadCount: meta.hydrationRemoteReadCount,
    lostLeadershipRunCount: meta.hydrationLostLeadershipRunCount,
    failedRunCount: meta.hydrationFailedRunCount,
    lastDurationMs: meta.lastHydrationDurationMs,
    lastCompletedAt: meta.lastHydrationCompletedAt,
    ...(meta.published ? { installedPublication: {
      firstDay: meta.published.firstDay, lastDay: meta.published.lastDay, sourceThrough: meta.published.sourceThrough,
    } } : {}),
    ...(recent ? { recentOnly: true, ...(isReadingUploadTime(recent.rejectedSourceThrough)
      ? { rejectedPublicationCutoff: recent.rejectedSourceThrough } : {}) } : {}),
  };
};

export const hydrateRemoteReadingSessionsPageV12 = async (
  ownerKey: OwnerKey,
  sessions: readonly ReadingSessionV1[],
  expectedCursor: ReadingStatisticsRemoteCursorV12 | null,
  nextCursor: ReadingStatisticsRemoteCursorV12 | null,
  fullHydrationCompleted: boolean,
  notify = true,
  quarantinedDocuments: readonly QuarantinedReadingStatisticsDocumentV12[] = [],
  now = Date.now(),
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  timestampRangeOnly = false,
  published?: ReadingRollupCheckpoint,
  recentOnly = false,
) => {
  if (
    (sessions.length > 0 || quarantinedDocuments.length > 0)
    && !nextCursor
    && !fullHydrationCompleted
  ) {
    throw new Error('원격 독서 통계 page cursor가 없습니다.');
  }
  if (expectedCursor && !readRemoteCursor(expectedCursor)) {
    throw new Error('이전 독서 통계 page cursor가 올바르지 않습니다.');
  }
  if (nextCursor && !readRemoteCursor(nextCursor)) {
    throw new Error('다음 독서 통계 page cursor가 올바르지 않습니다.');
  }
  const validatedQuarantinedDocuments = readQuarantinedDocuments(quarantinedDocuments);
  if (validatedQuarantinedDocuments.length !== quarantinedDocuments.length) {
    throw new Error('원격 독서 통계 quarantine 정보가 올바르지 않습니다.');
  }
  const ids = new Set<string>();
  for (const session of sessions) {
    if (!isReadingSessionV1(session)) {
      throw new Error('원격 독서 통계 session schema가 올바르지 않습니다.');
    }
    if (ids.has(session.sessionId)) {
      throw new Error('원격 독서 통계 응답에 중복 session ID가 있습니다.');
    }
    ids.add(session.sessionId);
  }

  const db = await initDB();
  const tx = db.transaction([
    V11_READING_SESSIONS_STORE,
    V12_READING_STATISTICS_SYNC_STORE,
    V13_READING_STATISTICS_LEASES_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const sessionsStore = tx.objectStore(V11_READING_SESSIONS_STORE);
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  let nextQuarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[];
  try {
    if (
      leaseClaim
      && !await hasCurrentStatisticsLease(
        tx.objectStore(V13_READING_STATISTICS_LEASES_STORE),
        ownerKey,
        leaseClaim,
        now,
      )
    ) {
      throw new Error('독서 통계 hydration lease가 변경되었습니다.');
    }
    const recentKey = readingStatisticsRecentKey(ownerKey);
    const [value, recentRow] = await Promise.all([metaStore.get(ownerKey), metaStore.get(recentKey)]);
    if (recentOnly !== Boolean(recentRow)) throw new Error('독서 통계 수신 범위가 변경되었습니다.');
    const currentValue = recentOnly ? recentRow.state : value;
    const current = currentValue ? assertSyncMeta(currentValue) : null;
    if (expectedCursor && (!current?.cursorVersion || !sameCursor(current, expectedCursor))) {
      throw new Error('독서 통계 hydration cursor가 다른 작업에 의해 변경되었습니다.');
    }
    const discarded = new Set<string>();
    if (published) {
      if (!current?.published || current.fullAuditInProgress || !samePublishedReading(current.published, published)
        || (!expectedCursor && current.documentId !== '__empty__')) {
        throw new Error('독서 통계 발행 커서가 다른 작업에 의해 변경되었습니다.');
      }
      for (const row of validatedQuarantinedDocuments) discarded.add(row.documentId);
      if (sessions.length) {
        const index = sessionsStore.index('by-owner');
        const dayKey = readingStatisticsDayStorageKey(ownerKey);
        const [legacy, dayRows, dayMeta] = await Promise.all([
          index.getAll(ownerKey), readingDayReadsEnabled() ? index.getAll(dayKey) : [],
          readingDayReadsEnabled() ? metaStore.get(dayKey) : undefined,
        ]);
        const day = readDayState(dayMeta);
        const received = visibleReadingSessions(ownerKey, legacy.map(assertStoredSession),
          day && sameDayPublication(day.publication, published) ? dayRows : []).filter(hasPublicationReceipt);
        const receivedIds = new Set(received.map(({ sessionId }) => sessionId));
        const incoming = sessions.filter(({ sessionId }) => !receivedIds.has(sessionId));
        const open = new Set(selectReadingRollupTail(published, received, incoming).map(({ sessionId }) => sessionId));
        for (const { sessionId } of incoming) {
          if (!open.has(sessionId)) discarded.add(sessionId);
        }
      }
    }
    let added = 0;
    if (published) {
      for (const document of validatedQuarantinedDocuments) {
        const key = [ownerKey, document.documentId];
        const existing = readStoredSession(await sessionsStore.get(key));
        if (existing?.syncState === 'synced' && !hasPublicationReceipt(existing)) {
          await sessionsStore.delete(key);
        }
      }
    }
    for (const session of sessions) {
      const key = [ownerKey, session.sessionId];
      const existingValue = await sessionsStore.get(key);
      const existing = readStoredSession(existingValue);
      // A replay cannot replace a payload already used with this publication.
      if (published && hasPublicationReceipt(existing)) continue;
      if (discarded.has(session.sessionId)) {
        if (existingValue && existing?.syncState !== 'pending') {
          await sessionsStore.delete(key);
        }
        continue;
      }
      if (!existingValue) {
        await sessionsStore.add({ ...toStoredSession(ownerKey, session, 'synced'), ...(published ? { receivedWithPublication: true } : {}) });
        added++;
        continue;
      }
      if (!hasPublicationReceipt(existing)) added++;
      if (!existing || !sameReadingSessionPayload(existing, session)) {
        // Cloud sessions are immutable after creation. If an older client left
        // a different local payload under the same ID, converge on the
        // already-committed remote record instead of blocking the whole page.
        await sessionsStore.put({ ...toStoredSession(ownerKey, session, 'synced'), ...(published ? { receivedWithPublication: true } : {}) });
        continue;
      }
      if (existing.syncState !== 'synced' || (published && !hasPublicationReceipt(existing))) {
        await sessionsStore.put({
          ...existing,
          syncState: 'synced',
          retryCount: 0,
          nextAttemptAt: 0,
          lastErrorCode: null,
          ...(published ? { receivedWithPublication: true } : {}),
        });
      }
    }

    const isFullAudit = !recentOnly && ((!timestampRangeOnly && expectedCursor === null) || current?.fullAuditInProgress === true);
    const preserveCheckpoint = expectedCursor !== null || timestampRangeOnly;
    const quarantineById = new Map(
      (preserveCheckpoint ? current?.quarantinedDocuments ?? [] : [])
        .map((item) => [item.documentId, item]),
    );
    for (const id of ids) quarantineById.delete(id);
    for (const item of validatedQuarantinedDocuments) quarantineById.set(item.documentId, item);
    nextQuarantinedDocuments = [...quarantineById.values()]
      .sort((left, right) => left.detectedAt - right.detectedAt)
      .slice(-MAX_QUARANTINED_READING_STATISTICS_DOCUMENTS);
    const cursor = nextCursor ?? expectedCursor;
    if (cursor || fullHydrationCompleted) {
      const empty = createEmptySyncMeta(ownerKey);
      const archivedCursor = published && cursor && ((nextCursor && discarded.has(nextCursor.documentId))
        || (current?.archivedCursor && sameCursor(current.archivedCursor, cursor))) ? cursor : undefined;
      const state = {
        ...(current ?? empty),
        uploadedAtServerSeconds: cursor?.uploadedAtServerSeconds ?? empty.uploadedAtServerSeconds,
        uploadedAtServerNanoseconds: cursor?.uploadedAtServerNanoseconds ?? empty.uploadedAtServerNanoseconds,
        documentId: cursor?.documentId ?? empty.documentId,
        cursorVersion: 1,
        fullHydrationCompleted: !recentOnly && fullHydrationCompleted,
        hydratedRemoteCount: (preserveCheckpoint ? current?.hydratedRemoteCount ?? 0 : 0)
          + (published ? added : sessions.length),
        lastFullAuditAt: isFullAudit && fullHydrationCompleted
          ? now
          : current?.lastFullAuditAt ?? 0,
        lastVerifiedAuditAt: current?.lastVerifiedAuditAt ?? 0,
        lastPublishedAuditAt: isFullAudit ? 0 : current?.lastPublishedAuditAt ?? 0,
        fullAuditInProgress: isFullAudit && !fullHydrationCompleted,
        quarantinedDocuments: nextQuarantinedDocuments,
        published: isFullAudit && fullHydrationCompleted ? undefined : current?.published,
        archivedCursor,
      } satisfies ReadingStatisticsSyncMetaV12;
      await metaStore.put(recentOnly ? { ...recentRow, ownerKey: recentKey, state } : state);
      if (isFullAudit && fullHydrationCompleted) await metaStore.delete(readingStatisticsArchiveKey(ownerKey));
    }
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    throw error;
  }
  if (notify && sessions.length > 0) notifyReadingStatisticsChange(ownerKey);
  return { quarantinedDocuments: nextQuarantinedDocuments };
};

export const reconcileUploadedReadingSessionConflictV11 = async (
  ownerKey: OwnerKey,
  expectedLocal: ReadingSessionV1,
  remote: ReadingSessionV1,
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  now = Date.now(),
  onCommitted = notifyReadingStatisticsChange,
) => {
  if (
    !isReadingSessionV1(remote)
    || remote.sessionId !== expectedLocal.sessionId
  ) throw new Error('원격 독서 통계 충돌 기록이 올바르지 않습니다.');
  const db = await initDB();
  const tx = db.transaction([
    V11_READING_SESSIONS_STORE,
    V13_READING_STATISTICS_LEASES_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  if (
    leaseClaim
    && !await hasCurrentStatisticsLease(
      tx.objectStore(V13_READING_STATISTICS_LEASES_STORE),
      ownerKey,
      leaseClaim,
      now,
    )
  ) {
    await tx.done;
    return false;
  }
  const storageKey = readingSessionStorageKey(ownerKey, expectedLocal.sessionId);
  const value = await store.get([storageKey, expectedLocal.sessionId]);
  if (!value) {
    await tx.done;
    return false;
  }
  const existing = assertStoredSession(value);
  if (!sameReadingSessionPayload(existing, expectedLocal)) {
    await tx.done;
    return false;
  }
  await store.put({ ...toStoredSession(ownerKey, remote, 'synced'), ownerKey: storageKey });
  await tx.done;
  onCommitted(ownerKey);
  return true;
};

export const recordReadingStatisticsHydrationMetricsV12 = async (
  ownerKey: OwnerKey,
  metrics: {
    pageCount: number;
    remoteReadAttemptCount?: number;
    remoteReadCount: number;
    durationMs: number;
    completedAt?: number;
    status?: 'completed' | 'lost-leadership' | 'failed';
  },
) => {
  if (
    !Number.isSafeInteger(metrics.pageCount)
    || metrics.pageCount < 0
    || !Number.isSafeInteger(metrics.remoteReadAttemptCount ?? metrics.remoteReadCount)
    || Number(metrics.remoteReadAttemptCount ?? metrics.remoteReadCount) < metrics.remoteReadCount
    || !Number.isSafeInteger(metrics.remoteReadCount)
    || metrics.remoteReadCount < metrics.pageCount
    || !Number.isFinite(metrics.durationMs)
    || metrics.durationMs < 0
  ) throw new Error('독서 통계 hydration 계측값이 올바르지 않습니다.');
  const db = await initDB();
  const tx = db.transaction(V12_READING_STATISTICS_SYNC_STORE, 'readwrite');
  const store = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const value = await store.get(ownerKey);
  const current = value ? assertSyncMeta(value) : createEmptySyncMeta(ownerKey);
  await store.put({
    ...current,
    hydrationRunCount: current.hydrationRunCount + 1,
    hydrationPageCount: current.hydrationPageCount + metrics.pageCount,
    hydrationRemoteReadAttemptCount: current.hydrationRemoteReadAttemptCount
      + (metrics.remoteReadAttemptCount ?? metrics.remoteReadCount),
    hydrationRemoteReadCount: current.hydrationRemoteReadCount + metrics.remoteReadCount,
    hydrationLostLeadershipRunCount: current.hydrationLostLeadershipRunCount
      + Number(metrics.status === 'lost-leadership'),
    hydrationFailedRunCount: current.hydrationFailedRunCount
      + Number(metrics.status === 'failed'),
    lastHydrationDurationMs: metrics.durationMs,
    lastHydrationCompletedAt: metrics.completedAt ?? Date.now(),
  } satisfies ReadingStatisticsSyncMetaV12);
  await tx.done;
  return true;
};

const queuedSessionReads = new Map<OwnerKey, { result: Promise<StoredReadingSessionV11[]>; shared: boolean }>();

const sortLocalReadingSessions = (values: unknown[]) => values.map(assertStoredSession).sort((left, right) => (
  left.startedAtClient - right.startedAtClient || left.sessionId.localeCompare(right.sessionId)
));

function visibleReadingSessions(
  ownerKey: OwnerKey, legacy: StoredReadingSessionV11[], dayValues: unknown[],
) {
  if (!dayValues.length) return legacy;
  const rows = new Map(legacy.map((row) => [row.sessionId, row]));
  for (const value of dayValues) {
    const day = assertStoredSession(value) as PublishedStoredSession;
    if (day.tailAdmitted === false) continue;
    if (!rows.has(day.sessionId)) rows.set(day.sessionId, { ...day, ownerKey, ...(day.tailAdmitted && { receivedWithPublication: true }) });
  }
  return sortLocalReadingSessions([...rows.values()]);
}

export const getLocalReadingSessionsV11 = async (ownerKey: OwnerKey) => {
  let read = queuedSessionReads.get(ownerKey);
  if (read) {
    read.shared = true;
  } else {
    const result = (async () => {
      const db = await initDB().finally(() => {
        // A caller arriving after transaction submission opens a new snapshot.
        queuedSessionReads.delete(ownerKey);
      });
      const index = db.transaction(V11_READING_SESSIONS_STORE).store.index('by-owner');
      const [values, days] = await Promise.all([
        index.getAll(ownerKey),
        isGuestOwner(ownerKey) ? [] : index.getAll(readingStatisticsDayStorageKey(ownerKey)),
      ]);
      return visibleReadingSessions(ownerKey, sortLocalReadingSessions(values), days);
    })();
    read = { result, shared: false };
    queuedSessionReads.set(ownerKey, read);
  }
  const sessions = await read.result;
  if (!read.shared) return sessions;
  return sessions.map((session) => session.activeIntervals
    ? { ...session, activeIntervals: session.activeIntervals.map((interval) => ({ ...interval })) }
    : { ...session });
};

export async function getLocalReadingReportSnapshot(ownerKey: OwnerKey, verifyHistory: boolean) {
  if (!verifyHistory) return { sessions: await getLocalReadingSessionsV11(ownerKey), rawHistoryComplete: false, published: undefined, tailComplete: false, recentOnly: false };
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE]);
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const index = tx.objectStore(V11_READING_SESSIONS_STORE).index('by-owner');
  const includeDay = !isGuestOwner(ownerKey);
  const dayKey = readingStatisticsDayStorageKey(ownerKey);
  const [values, value, recentRow, archiveKey, dayValues, dayState, baselineRow] = await Promise.all([
    index.getAll(ownerKey),
    metaStore.get(ownerKey), metaStore.get(readingStatisticsRecentKey(ownerKey)), metaStore.getKey(readingStatisticsArchiveKey(ownerKey)),
    includeDay ? index.getAll(dayKey) : [], includeDay ? metaStore.get(dayKey) : undefined,
    includeDay ? metaStore.get(readingStatisticsDayBaselineKey(ownerKey)) : undefined,
  ]);
  await tx.done;
  const legacy = sortLocalReadingSessions(values);
  const meta = value ? assertSyncMeta(value) : null;
  const published = meta?.published;
  const day = readDayState(dayState);
  const requiresDaySource = includeDay && (readingDayReadsEnabled() || day !== null || dayValues.length > 0);
  const baseline = dayBaselineIds(baselineRow, published);
  const baselineRows = published && requiresDaySource && baseline
    ? legacy.filter(({ sessionId }) => baseline.has(sessionId)) : undefined;
  const dayComplete = Boolean(day?.ready && day.completed && day.legacyCompleted
    && sameDayPublication(day.publication, published) && baselineRows && baselineRows.length === baseline?.size
    && countDayReceipts(dayValues) === day.receiptCount);
  const selectedLegacy = published && requiresDaySource && baselineRows
    ? [...baselineRows, ...legacy.filter(({ syncState }) => syncState === 'pending')]
    : legacy;
  const sessions = visibleReadingSessions(ownerKey, selectedLegacy, dayComplete || !published
    ? dayValues : dayValues.filter((row) => readStoredSession(row)?.syncState === 'pending'));
  if (recentRow || (archiveKey && !meta?.published)) {
    return { sessions, rawHistoryComplete: false, published: undefined, tailComplete: false, recentOnly: true };
  }
  const receivedSessions = meta?.published ? sessions.filter((row) => row.syncState === 'synced' && hasPublicationReceipt(row)) : [];
  const legacyReceived = meta?.published ? legacy.filter((row) => row.syncState === 'synced' && hasPublicationReceipt(row)) : [];
  const received = Boolean(meta?.fullHydrationCompleted && !meta.fullAuditInProgress
    && (meta.published
      ? legacyReceived.length === meta.hydratedRemoteCount && hasPublishedCursor(meta, legacyReceived)
      : meta.quarantinedDocuments.length === 0
        && legacy.filter(({ syncState }) => syncState === 'synced').length >= meta.hydratedRemoteCount));
  let visible = sessions;
  if (published) {
    const receivedIds = new Set(receivedSessions.map(({ sessionId }) => sessionId));
    const quarantinedIds = new Set(meta.quarantinedDocuments.map(({ documentId }) => documentId));
    const unreceived = sessions.filter(({ sessionId }) => !receivedIds.has(sessionId) && !quarantinedIds.has(sessionId));
    const openIds = new Set(selectReadingRollupTail(published, receivedSessions, unreceived).map(({ sessionId }) => sessionId));
    visible = sessions.filter(({ sessionId }) => receivedIds.has(sessionId) || openIds.has(sessionId));
  }
  return { sessions: visible, rawHistoryComplete: received && !requiresDaySource && !published && Boolean(meta?.lastFullAuditAt),
    published, tailComplete: Boolean(published) && (requiresDaySource ? dayComplete : received), recentOnly: false };
}

export async function getLocalReadingSessionsForFileTotals(
  ownerKey: OwnerKey, archive?: { firstDay: string; lastDay: string } | null,
) {
  if (!archive) return getLocalReadingSessionsV11(ownerKey);
  const report = await getLocalReadingReportSnapshot(ownerKey, true);
  return canMergeLocalReadingWithPublication(report, archive) ? report.sessions : [];
}

export const getPendingReadingSessionsV11 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
  limit = 40,
) => {
  const db = await initDB();
  const index = db.transaction(V11_READING_SESSIONS_STORE).store.index('by-owner-sync-next-attempt');
  const pending = (key: string) => index.getAll(IDBKeyRange.bound([key, 'pending', 0], [key, 'pending', now]), limit);
  const [legacy, days] = await Promise.all([pending(ownerKey),
    !readingDayWritesEnabled() || isGuestOwner(ownerKey) ? [] : pending(readingStatisticsDayStorageKey(ownerKey))]);
  if (!days.length) return legacy.map(assertStoredSession);
  return [...legacy, ...days].map(assertStoredSession)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.sessionId.localeCompare(b.sessionId))
    .slice(0, limit).map((session) => ({ ...session, ownerKey }));
};

export const markReadingSessionSyncedV11 = async (
  ownerKey: OwnerKey,
  sessionId: string,
  expected: ReadingSessionV1,
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  now = Date.now(),
  onCommitted = notifyReadingStatisticsChange,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V11_READING_SESSIONS_STORE,
    V13_READING_STATISTICS_LEASES_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  if (
    leaseClaim
    && !await hasCurrentStatisticsLease(
      tx.objectStore(V13_READING_STATISTICS_LEASES_STORE),
      ownerKey,
      leaseClaim,
      now,
    )
  ) {
    await tx.done;
    return false;
  }
  const value = await store.get([readingSessionStorageKey(ownerKey, sessionId), sessionId]);
  if (!value) {
    await tx.done;
    return false;
  }
  const existing = assertStoredSession(value);
  if (!sameReadingSessionPayload(existing, expected)) {
    tx.abort();
    throw new Error('동기화 완료 대상 독서 session이 변경되었습니다.');
  }
  await store.put({
    ...existing,
    syncState: 'synced',
    retryCount: 0,
    nextAttemptAt: 0,
    lastErrorCode: null,
  });
  await tx.done;
  onCommitted(ownerKey);
  return true;
};

export const deferReadingSessionSyncV11 = async (
  ownerKey: OwnerKey,
  sessionId: string,
  errorCode: string,
  now = Date.now(),
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  onCommitted = notifyReadingStatisticsChange,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V11_READING_SESSIONS_STORE,
    V13_READING_STATISTICS_LEASES_STORE,
  ], 'readwrite');
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
  if (
    leaseClaim
    && !await hasCurrentStatisticsLease(
      tx.objectStore(V13_READING_STATISTICS_LEASES_STORE),
      ownerKey,
      leaseClaim,
      now,
    )
  ) {
    await tx.done;
    return null;
  }
  const value = await store.get([readingSessionStorageKey(ownerKey, sessionId), sessionId]);
  if (!value) {
    await tx.done;
    return now;
  }
  const existing = assertStoredSession(value);
  const retryCount = existing.retryCount + 1;
  const delay = Math.min(60_000, 1_000 * (2 ** Math.min(6, retryCount - 1)));
  await store.put({
    ...existing,
    syncState: 'pending',
    retryCount,
    nextAttemptAt: now + delay,
    lastErrorCode: errorCode.slice(0, 120),
  });
  await tx.done;
  onCommitted(ownerKey);
  return now + delay;
};
