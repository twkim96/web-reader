import { initDB } from './localDB';
import {
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
} from './localDBSchema';
import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import { trackLocalCommit } from './localCommitTracker';
import {
  isReadingSessionV1,
  sameReadingSessionPayload,
  toReadingSessionPayload,
  type ReadingSessionV1,
  type StoredReadingSessionV11,
} from './readingStatistics';
import { notifyReadingStatisticsChange } from './readingStatisticsWake';

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

const assertStoredSession = (value: unknown): StoredReadingSessionV11 => {
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
  ) throw new Error('로컬 독서 통계 session이 손상되었습니다.');
  return value as StoredReadingSessionV11;
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
  fullAuditInProgress: boolean;
  quarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[];
};

const FULL_HYDRATION_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const MAX_QUARANTINED_DOCUMENTS = 100;
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
    fullAuditInProgress: 'fullAuditInProgress' in value
      && value.fullAuditInProgress === true,
    quarantinedDocuments: 'quarantinedDocuments' in value
      ? readQuarantinedDocuments(value.quarantinedDocuments)
      : [],
  };
};

const sameCursor = (
  left: ReadingStatisticsRemoteCursorV12,
  right: ReadingStatisticsRemoteCursorV12,
) => left.uploadedAtServerSeconds === right.uploadedAtServerSeconds
  && left.uploadedAtServerNanoseconds === right.uploadedAtServerNanoseconds
  && left.documentId === right.documentId;

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

export const getReadingStatisticsHydrationStateV12 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V11_READING_SESSIONS_STORE,
    V12_READING_STATISTICS_SYNC_STORE,
  ], 'readonly');
  const metaValue = await tx.objectStore(V12_READING_STATISTICS_SYNC_STORE).get(ownerKey);
  if (!metaValue) {
    await tx.done;
    return null;
  }
  const meta = assertSyncMeta(metaValue);
  if (meta.ownerKey !== ownerKey) throw new Error('독서 통계 hydration owner가 올바르지 않습니다.');
  const localCount = await tx.objectStore(V11_READING_SESSIONS_STORE)
    .index('by-owner')
    .count(ownerKey);
  await tx.done;
  // If the raw-session store was cleared independently, never let a surviving
  // cursor hide the older remote records. A new authoritative full hydration
  // will atomically replace this metadata.
  if (localCount < meta.hydratedRemoteCount) return null;
  if (
    !meta.fullAuditInProgress
    && now - meta.lastFullAuditAt >= FULL_HYDRATION_AUDIT_INTERVAL_MS
  ) return null;
  return {
    cursor: meta.documentId === '__empty__' ? null : {
      uploadedAtServerSeconds: meta.uploadedAtServerSeconds,
      uploadedAtServerNanoseconds: meta.uploadedAtServerNanoseconds,
      documentId: meta.documentId,
    },
    fullHydrationCompleted: meta.fullHydrationCompleted,
    quarantinedDocuments: meta.quarantinedDocuments,
    lastFullAuditAt: meta.lastFullAuditAt,
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
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const sessionsStore = tx.objectStore(V11_READING_SESSIONS_STORE);
  const metaStore = tx.objectStore(V12_READING_STATISTICS_SYNC_STORE);
  try {
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
      const existing = assertStoredSession(existingValue);
      if (!sameReadingSessionPayload(existing, session)) {
        throw new Error('원격 독서 통계 session ID가 다른 로컬 내용과 충돌했습니다.');
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
        fullAuditInProgress: isFullAudit && !fullHydrationCompleted,
        quarantinedDocuments: nextQuarantinedDocuments,
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
        fullAuditInProgress: false,
        quarantinedDocuments: nextQuarantinedDocuments,
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

export const getLocalReadingSessionsV11 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const values = await db.getAllFromIndex(V11_READING_SESSIONS_STORE, 'by-owner', ownerKey);
  return values.map(assertStoredSession).sort((left, right) => (
    left.startedAtClient - right.startedAtClient || left.sessionId.localeCompare(right.sessionId)
  ));
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
) => {
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  void tx.done.catch(() => undefined);
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
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
) => {
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  const store = tx.objectStore(V11_READING_SESSIONS_STORE);
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
