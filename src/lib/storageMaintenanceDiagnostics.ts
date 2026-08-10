import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
  V11_READING_SESSIONS_STORE,
  V8_ANNOTATIONS_STORE,
} from './localDBSchema';
import { getReadingStatisticsHydrationMetricsV12 } from './localReadingStatistics';
import type { OwnerKey } from './ownerIdentity';
import { buildReadingStatistics, isReadingSessionV1 } from './readingStatistics';
import type {
  RemoteHeadCacheV5,
  SyncConflictV5,
  SyncOutboxEventV5,
} from './syncOutboxV5';

const DAY_MS = 24 * 60 * 60_000;
const SUPERSEDED_OUTBOX_OBSERVATION_MS = 30 * DAY_MS;
const RESOLVED_CONFLICT_OBSERVATION_MS = 30 * DAY_MS;
export const MINIMUM_REMOTE_TOMBSTONE_RETENTION_DAYS = 90;

const approximateBytes = (values: readonly unknown[]) => {
  const encoder = new TextEncoder();
  return values.reduce<number>((total, value) => {
    try {
      return total + encoder.encode(JSON.stringify(value)).byteLength;
    } catch {
      return total;
    }
  }, 0);
};

const ageMs = (now: number, timestamps: number[]) => {
  const oldest = timestamps.reduce(
    (current, value) => Math.min(current, value),
    Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(oldest) ? Math.max(0, now - oldest) : 0;
};

const countBy = <T>(values: readonly T[], readKey: (value: T) => string) => (
  values.reduce<Record<string, number>>((counts, value) => {
    const key = readKey(value);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {})
);

const readOwnerRange = (ownerKey: OwnerKey) => IDBKeyRange.bound(
  [ownerKey, ''],
  [ownerKey, '\uffff'],
);

export type StorageMaintenanceDiagnosticsV1 = {
  schemaVersion: 1;
  ownerKey: OwnerKey;
  collectedAt: number;
  collectionDurationMs: number;
  outbox: {
    count: number;
    approximateBytes: number;
    byStatus: Record<string, number>;
    oldestAgeMs: number;
    supersededOlderThan30Days: number;
  };
  conflicts: {
    count: number;
    approximateBytes: number;
    byState: Record<string, number>;
    oldestAgeMs: number;
    resolvedOlderThan30Days: number;
  };
  annotations: {
    count: number;
    approximateBytes: number;
    unresolvedCount: number;
    bookDeletionMarkerCount: number;
  };
  remoteHeads: {
    count: number;
    approximateBytes: number;
    tombstoneCount: number;
    receiptCount: null;
    receiptCountReason: 'server-only';
  };
  readingStatistics: {
    rawSessionCount: number;
    malformedRecordCount: number;
    approximateBytes: number;
    bySyncState: Record<string, number>;
    byMonth: Record<string, number>;
    oldestAgeMs: number;
    aggregationDurationMs: number;
    hydration: Awaited<ReturnType<typeof getReadingStatisticsHydrationMetricsV12>>;
  };
  quota: {
    usage: number | null;
    quota: number | null;
    ratio: number | null;
  };
};

export const collectStorageMaintenanceDiagnosticsV1 = async (
  ownerKey: OwnerKey,
  options: {
    now?: number;
    estimateStorage?: () => Promise<{ usage?: number; quota?: number }>;
    monotonicNow?: () => number;
  } = {},
): Promise<StorageMaintenanceDiagnosticsV1> => {
  const now = options.now ?? Date.now();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const db = await initDB();
  const [outbox, conflicts, remoteHeads, annotations, deletionMarkers, sessions, hydration] =
    await Promise.all([
      db.getAll(V5_OUTBOX_STORE, readOwnerRange(ownerKey)) as Promise<SyncOutboxEventV5[]>,
      db.getAll(V5_SYNC_CONFLICTS_STORE, readOwnerRange(ownerKey)) as Promise<SyncConflictV5[]>,
      db.getAllFromIndex(V5_REMOTE_HEADS_STORE, 'by-owner', ownerKey) as
        Promise<RemoteHeadCacheV5[]>,
      db.getAllFromIndex(V8_ANNOTATIONS_STORE, 'by-owner', ownerKey) as
        Promise<Array<{ anchorState?: string }>>,
      db.getAllFromIndex(V10_ANNOTATION_BOOK_DELETIONS_STORE, 'by-owner', ownerKey) as
        Promise<unknown[]>,
      db.getAllFromIndex(V11_READING_SESSIONS_STORE, 'by-owner', ownerKey) as Promise<unknown[]>,
      getReadingStatisticsHydrationMetricsV12(ownerKey),
    ]);
  const aggregationStartedAt = monotonicNow();
  const validSessions = sessions.filter(isReadingSessionV1);
  try {
    buildReadingStatistics(validSessions);
  } catch {
    // Diagnostics must still report the raw store when one record is malformed.
  }
  const aggregationDurationMs = Math.max(0, monotonicNow() - aggregationStartedAt);
  let storageEstimate: { usage?: number; quota?: number } = {};
  try {
    const estimate = options.estimateStorage
      ?? (() => navigator.storage?.estimate?.() ?? Promise.resolve({}));
    storageEstimate = await estimate();
  } catch {
    storageEstimate = {};
  }
  const usage = Number.isFinite(storageEstimate.usage) ? Number(storageEstimate.usage) : null;
  const quota = Number.isFinite(storageEstimate.quota) && Number(storageEstimate.quota) > 0
    ? Number(storageEstimate.quota)
    : null;
  return {
    schemaVersion: 1,
    ownerKey,
    collectedAt: now,
    collectionDurationMs: Math.max(0, monotonicNow() - startedAt),
    outbox: {
      count: outbox.length,
      approximateBytes: approximateBytes(outbox),
      byStatus: countBy(outbox, ({ status }) => status),
      oldestAgeMs: ageMs(now, outbox.map(({ occurredAtClient }) => occurredAtClient)),
      supersededOlderThan30Days: outbox.filter((event) => (
        event.status === 'superseded'
        && now - event.occurredAtClient >= SUPERSEDED_OUTBOX_OBSERVATION_MS
      )).length,
    },
    conflicts: {
      count: conflicts.length,
      approximateBytes: approximateBytes(conflicts),
      byState: countBy(conflicts, ({ state }) => state),
      oldestAgeMs: ageMs(now, conflicts.map(({ createdAt }) => createdAt)),
      resolvedOlderThan30Days: conflicts.filter((conflict) => (
        (conflict.state === 'resolved_local' || conflict.state === 'resolved_remote')
        && now - (conflict.resolvedAt ?? conflict.createdAt) >= RESOLVED_CONFLICT_OBSERVATION_MS
      )).length,
    },
    annotations: {
      count: annotations.length,
      approximateBytes: approximateBytes(annotations),
      unresolvedCount: annotations.filter(({ anchorState }) => anchorState === 'unresolved').length,
      bookDeletionMarkerCount: deletionMarkers.length,
    },
    remoteHeads: {
      count: remoteHeads.length,
      approximateBytes: approximateBytes(remoteHeads),
      tombstoneCount: remoteHeads.filter(({ head }) => (
        head.operation === 'delete' || head.operation === 'reset'
      )).length,
      receiptCount: null,
      receiptCountReason: 'server-only',
    },
    readingStatistics: {
      rawSessionCount: sessions.length,
      malformedRecordCount: sessions.length - validSessions.length,
      approximateBytes: approximateBytes(sessions),
      bySyncState: countBy(sessions, (session) => {
        if (typeof session !== 'object' || session === null || !('syncState' in session)) {
          return 'unknown';
        }
        return typeof session.syncState === 'string' ? session.syncState : 'unknown';
      }),
      byMonth: countBy(validSessions, ({ localDate }) => localDate.slice(0, 7)),
      oldestAgeMs: ageMs(now, validSessions.map(({ startedAtClient }) => startedAtClient)),
      aggregationDurationMs,
      hydration,
    },
    quota: {
      usage,
      quota,
      ratio: usage !== null && quota !== null ? usage / quota : null,
    },
  };
};

export type StorageMaintenanceMigrationEvidenceV1 = {
  maximumOfflineDaysTested: number;
  authoritativeSnapshotEquivalent: boolean;
  readingStatisticsTotalsEquivalent: boolean;
  rollbackPassed: boolean;
  legacyClientReconnectPassed: boolean;
};

export const planStorageMaintenanceMigrationV1 = (
  evidence: StorageMaintenanceMigrationEvidenceV1,
) => {
  const blockers = [
    evidence.maximumOfflineDaysTested < MINIMUM_REMOTE_TOMBSTONE_RETENTION_DAYS
      ? '90일 offline 복귀 증거 부족'
      : null,
    !evidence.authoritativeSnapshotEquivalent ? 'authoritative snapshot 동등성 미검증' : null,
    !evidence.readingStatisticsTotalsEquivalent ? '독서 통계 합계 동등성 미검증' : null,
    !evidence.rollbackPassed ? 'rollback 미검증' : null,
    !evidence.legacyClientReconnectPassed ? '구버전 client 재접속 미검증' : null,
  ].filter((value): value is string => Boolean(value));
  return {
    status: blockers.length === 0 ? 'migration-ready' as const : 'observe-only' as const,
    automaticDeletionEnabled: false,
    blockers,
    policy: {
      localSupersededOutboxObservationDays: 30,
      localResolvedConflictObservationDays: 30,
      minimumRemoteTombstoneAndReceiptDays: MINIMUM_REMOTE_TOMBSTONE_RETENTION_DAYS,
      rawStatisticsStrategy: 'monthly-immutable-archive-after-verified-full-audit' as const,
      requiresServerWatermark: true,
      requiresExportAndAccountDeletionCompatibility: true,
    },
  };
};
