import { initDB } from './localDB';
import {
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
  V13_READING_STATISTICS_LEASES_STORE,
} from './localDBSchema';
import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import { trackLocalCommit } from './localCommitTracker';
import {
  createReadingRoundCompletionSession,
  isReadingSessionV1,
  sameReadingSessionPayload,
  toReadingSessionPayload,
  type ReadingSessionV1,
  type StoredReadingSessionV11,
} from './readingStatistics';
import { notifyReadingStatisticsChange } from './readingStatisticsWake';
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
  fullHydrationCompleted: boolean;
  hydratedRemoteCount: number;
  lastFullAuditAt: number;
  lastVerifiedAuditAt: number;
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
};

const HYDRATION_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const FULL_HYDRATION_AUDIT_INTERVAL_MS = 4 * HYDRATION_AUDIT_INTERVAL_MS;
const MAX_QUARANTINED_DOCUMENTS = 100;
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
    )).slice(-MAX_QUARANTINED_DOCUMENTS)
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
  return {
    ...cursor,
    ownerKey: value.ownerKey as OwnerKey,
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
    fullAuditInProgress: 'fullAuditInProgress' in value
      && value.fullAuditInProgress === true,
    quarantinedDocuments: 'quarantinedDocuments' in value
      ? readQuarantinedDocuments(value.quarantinedDocuments)
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
  uploadedAtServerSeconds: 0,
  uploadedAtServerNanoseconds: 0,
  documentId: '__empty__',
  fullHydrationCompleted: false,
  hydratedRemoteCount: 0,
  lastFullAuditAt: 0,
  lastVerifiedAuditAt: 0,
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
  const existingValue = await store.get([ownerKey, session.sessionId]);
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
    await store.add(toStoredSession(
      ownerKey,
      session,
      source === 'remote' || isGuestOwner(ownerKey) ? 'synced' : 'pending',
    ));
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
  | 'weekly-audit-unavailable'
  | 'remote-audit-mismatch'
  | 'remote-audit-failed'
  | 'audit-checkpoint-changed';

type LocalFullScan = { reason: ReadingStatisticsFullScanReason; catchUpFrom?: ReadingStatisticsAuditCandidateV12 };
type ReadingStatisticsHydrationStateV12 = {
  cursor: ReadingStatisticsRemoteCursorV12 | null;
  fullHydrationCompleted: boolean;
  quarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[];
  lastFullAuditAt: number;
};
type ReadingStatisticsHydrationPlanV12 =
  | { state: ReadingStatisticsHydrationStateV12; reason?: 'empty-history' | 'initial-history' }
  | { candidate: ReadingStatisticsAuditCandidateV12 }
  | LocalFullScan;

const getAuditCandidate = async (
  sessions: { index: (name: string) => { count: (range: IDBKeyRange) => Promise<number> }; get: (key: [OwnerKey, string]) => Promise<unknown> },
  ownerKey: OwnerKey,
  meta: ReadingStatisticsSyncMetaV12,
  now: number,
): Promise<{ candidate: ReadingStatisticsAuditCandidateV12 } | LocalFullScan> => {
  if (meta.documentId === '__empty__') return { reason: 'empty-history' };
  if (isGuestOwner(ownerKey) || meta.ownerKey !== ownerKey || !meta.fullHydrationCompleted || meta.fullAuditInProgress
    || meta.lastFullAuditAt === 0 || now - meta.lastFullAuditAt >= FULL_HYDRATION_AUDIT_INTERVAL_MS
    || now - Math.max(meta.lastFullAuditAt, meta.lastVerifiedAuditAt) < HYDRATION_AUDIT_INTERVAL_MS) {
    return { reason: 'weekly-audit-unavailable' };
  }
  const quarantinedDocumentIds = meta.quarantinedDocuments.map(({ documentId }) => documentId).sort();
  if (quarantinedDocumentIds.length > MAX_WEEKLY_QUARANTINE_PROBES
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
  };
  if (syncedCount > meta.hydratedRemoteCount) return { reason: 'local-synced-count-ahead', catchUpFrom: candidate };
  return { candidate };
};

export const getReadingStatisticsHydrationPlanV12 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
): Promise<ReadingStatisticsHydrationPlanV12> => {
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE]);
  const value = await tx.objectStore(V12_READING_STATISTICS_SYNC_STORE).get(ownerKey);
  if (!value) {
    await tx.done;
    return { reason: 'initial-history' };
  }
  const meta = assertSyncMeta(value);
  if (meta.ownerKey !== ownerKey) throw new Error('독서 통계 hydration owner가 올바르지 않습니다.');
  const sessions = tx.objectStore(V11_READING_SESSIONS_STORE);
  const localCount = await sessions.index('by-owner').count(ownerKey);
  let plan: ReadingStatisticsHydrationPlanV12;
  if (localCount < meta.hydratedRemoteCount) {
    // A surviving cursor must not hide older records after local data loss.
    plan = { reason: 'local-history-missing' };
  } else if (!meta.fullAuditInProgress && now - meta.lastFullAuditAt >= FULL_HYDRATION_AUDIT_INTERVAL_MS) {
    plan = { reason: 'periodic-full-audit' };
  } else if (!meta.fullAuditInProgress && now - Math.max(meta.lastFullAuditAt, meta.lastVerifiedAuditAt) >= HYDRATION_AUDIT_INTERVAL_MS) {
    plan = await getAuditCandidate(sessions, ownerKey, meta, now);
  } else {
    const { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId, fullHydrationCompleted, quarantinedDocuments, lastFullAuditAt } = meta;
    const cursor = documentId === '__empty__' ? null : { uploadedAtServerSeconds, uploadedAtServerNanoseconds, documentId };
    plan = {
      state: { cursor, fullHydrationCompleted, quarantinedDocuments, lastFullAuditAt },
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

export const recordReadingStatisticsVerifiedAuditV12 = async (
  ownerKey: OwnerKey,
  candidate: ReadingStatisticsAuditCandidateV12,
  leaseClaim: ReadingStatisticsSyncLeaseClaimV13,
  clock = Date.now,
) => {
  const db = await initDB();
  const tx = db.transaction([V11_READING_SESSIONS_STORE, V12_READING_STATISTICS_SYNC_STORE, V13_READING_STATISTICS_LEASES_STORE], 'readwrite');
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  const value = await metaStore.get(ownerKey);
  const check = value ? await getAuditCandidate(
    tx.objectStore(V11_READING_SESSIONS_STORE), ownerKey, assertSyncMeta(value), clock(),
  ) : null;
  const current = check && 'candidate' in check ? check.candidate : null;
  const lease = await tx.objectStore(V13_READING_STATISTICS_LEASES_STORE).get(ownerKey);
  const now = clock();
  const canRecord = current && current.remoteCount === candidate.remoteCount
    && current.lastFullAuditAt === candidate.lastFullAuditAt && current.lastVerifiedAuditAt === candidate.lastVerifiedAuditAt
    && sameCursor(current.cursor, candidate.cursor)
    && current.quarantinedDocumentIds.length === candidate.quarantinedDocumentIds.length
    && current.quarantinedDocumentIds.every((id, index) => id === candidate.quarantinedDocumentIds[index])
    && now - current.lastFullAuditAt < FULL_HYDRATION_AUDIT_INTERVAL_MS
    && isCurrentStatisticsLease(lease, leaseClaim, now);
  if (canRecord) await metaStore.put({ ...assertSyncMeta(value), lastVerifiedAuditAt: now });
  await tx.done;
  return Boolean(canRecord);
};

export const getReadingStatisticsHydrationMetricsV12 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const value = await db.get(V12_READING_STATISTICS_SYNC_STORE, ownerKey);
  if (!value) return null;
  const meta = assertSyncMeta(value);
  return {
    runCount: meta.hydrationRunCount,
    pageCount: meta.hydrationPageCount,
    remoteReadAttemptCount: meta.hydrationRemoteReadAttemptCount,
    remoteReadCount: meta.hydrationRemoteReadCount,
    lostLeadershipRunCount: meta.hydrationLostLeadershipRunCount,
    failedRunCount: meta.hydrationFailedRunCount,
    lastDurationMs: meta.lastHydrationDurationMs,
    lastCompletedAt: meta.lastHydrationCompletedAt,
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
    const currentValue = await metaStore.get(ownerKey);
    const current = currentValue ? assertSyncMeta(currentValue) : null;
    if (expectedCursor && (!current || !sameCursor(current, expectedCursor))) {
      throw new Error('독서 통계 hydration cursor가 다른 작업에 의해 변경되었습니다.');
    }
    for (const session of sessions) {
      const existingValue = await sessionsStore.get([ownerKey, session.sessionId]);
      if (!existingValue) {
        await sessionsStore.add(toStoredSession(ownerKey, session, 'synced'));
        continue;
      }
      const existing = readStoredSession(existingValue);
      if (!existing || !sameReadingSessionPayload(existing, session)) {
        // Cloud sessions are immutable after creation. If an older client left
        // a different local payload under the same ID, converge on the
        // already-committed remote record instead of blocking the whole page.
        await sessionsStore.put(toStoredSession(ownerKey, session, 'synced'));
        continue;
      }
      if (existing.syncState !== 'synced') {
        await sessionsStore.put({
          ...existing,
          syncState: 'synced',
          retryCount: 0,
          nextAttemptAt: 0,
          lastErrorCode: null,
        });
      }
    }

    const isFullAudit = expectedCursor === null || current?.fullAuditInProgress === true;
    const quarantineById = new Map(
      (expectedCursor ? current?.quarantinedDocuments ?? [] : [])
        .map((item) => [item.documentId, item]),
    );
    for (const item of validatedQuarantinedDocuments) quarantineById.set(item.documentId, item);
    const nextQuarantinedDocuments = [...quarantineById.values()]
      .sort((left, right) => left.detectedAt - right.detectedAt)
      .slice(-MAX_QUARANTINED_DOCUMENTS);
    const cursor = nextCursor ?? expectedCursor;
    if (cursor) {
      await metaStore.put({
        ownerKey,
        ...cursor,
        fullHydrationCompleted,
        hydratedRemoteCount: (expectedCursor ? current?.hydratedRemoteCount ?? 0 : 0)
          + sessions.length,
        lastFullAuditAt: isFullAudit && fullHydrationCompleted
          ? now
          : current?.lastFullAuditAt ?? 0,
        lastVerifiedAuditAt: current?.lastVerifiedAuditAt ?? 0,
        fullAuditInProgress: isFullAudit && !fullHydrationCompleted,
        quarantinedDocuments: nextQuarantinedDocuments,
        hydrationRunCount: current?.hydrationRunCount ?? 0,
        hydrationPageCount: current?.hydrationPageCount ?? 0,
        hydrationRemoteReadAttemptCount:
          current?.hydrationRemoteReadAttemptCount ?? 0,
        hydrationRemoteReadCount: current?.hydrationRemoteReadCount ?? 0,
        hydrationLostLeadershipRunCount:
          current?.hydrationLostLeadershipRunCount ?? 0,
        hydrationFailedRunCount: current?.hydrationFailedRunCount ?? 0,
        lastHydrationDurationMs: current?.lastHydrationDurationMs ?? 0,
        lastHydrationCompletedAt: current?.lastHydrationCompletedAt ?? 0,
      } satisfies ReadingStatisticsSyncMetaV12);
    } else if (fullHydrationCompleted) {
      // An empty authoritative collection still needs a durable full-hydration
      // marker. The sentinel document ID is never used as a query cursor.
      await metaStore.put({
        ownerKey,
        uploadedAtServerSeconds: 0,
        uploadedAtServerNanoseconds: 0,
        documentId: '__empty__',
        fullHydrationCompleted: true,
        hydratedRemoteCount: 0,
        lastFullAuditAt: now,
        lastVerifiedAuditAt: 0,
        fullAuditInProgress: false,
        quarantinedDocuments: nextQuarantinedDocuments,
        hydrationRunCount: current?.hydrationRunCount ?? 0,
        hydrationPageCount: current?.hydrationPageCount ?? 0,
        hydrationRemoteReadAttemptCount:
          current?.hydrationRemoteReadAttemptCount ?? 0,
        hydrationRemoteReadCount: current?.hydrationRemoteReadCount ?? 0,
        hydrationLostLeadershipRunCount:
          current?.hydrationLostLeadershipRunCount ?? 0,
        hydrationFailedRunCount: current?.hydrationFailedRunCount ?? 0,
        lastHydrationDurationMs: current?.lastHydrationDurationMs ?? 0,
        lastHydrationCompletedAt: current?.lastHydrationCompletedAt ?? 0,
      } satisfies ReadingStatisticsSyncMetaV12);
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
  return { quarantinedDocuments: nextCursor || fullHydrationCompleted
    ? (await getReadingStatisticsHydrationStateV12(ownerKey, now))?.quarantinedDocuments ?? []
    : [] };
};

export const reconcileUploadedReadingSessionConflictV11 = async (
  ownerKey: OwnerKey,
  expectedLocal: ReadingSessionV1,
  remote: ReadingSessionV1,
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  now = Date.now(),
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
  const value = await store.get([ownerKey, expectedLocal.sessionId]);
  if (!value) {
    await tx.done;
    return false;
  }
  const existing = assertStoredSession(value);
  if (!sameReadingSessionPayload(existing, expectedLocal)) {
    await tx.done;
    return false;
  }
  await store.put(toStoredSession(ownerKey, remote, 'synced'));
  await tx.done;
  notifyReadingStatisticsChange(ownerKey);
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
      const values = await db.getAllFromIndex(V11_READING_SESSIONS_STORE, 'by-owner', ownerKey);
      return values.map(assertStoredSession).sort((left, right) => (
        left.startedAtClient - right.startedAtClient || left.sessionId.localeCompare(right.sessionId)
      ));
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

export const getPendingReadingSessionsV11 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
  limit = 40,
) => {
  const db = await initDB();
  const values = await db.getAllFromIndex(
    V11_READING_SESSIONS_STORE,
    'by-owner-sync-next-attempt',
    IDBKeyRange.bound([ownerKey, 'pending', 0], [ownerKey, 'pending', now]),
    limit,
  );
  return values.map(assertStoredSession);
};

export const markReadingSessionSyncedV11 = async (
  ownerKey: OwnerKey,
  sessionId: string,
  expected: ReadingSessionV1,
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
  now = Date.now(),
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
  const value = await store.get([ownerKey, sessionId]);
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
  notifyReadingStatisticsChange(ownerKey);
  return true;
};

export const deferReadingSessionSyncV11 = async (
  ownerKey: OwnerKey,
  sessionId: string,
  errorCode: string,
  now = Date.now(),
  leaseClaim?: ReadingStatisticsSyncLeaseClaimV13,
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
  const value = await store.get([ownerKey, sessionId]);
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
  notifyReadingStatisticsChange(ownerKey);
  return now + delay;
};
