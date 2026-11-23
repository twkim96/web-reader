'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import {
  adoptLegacyReadingStatisticsCursorV12,
  beginReadingStatisticsRecentRecovery,
  deferReadingSessionSyncV11,
  getReadingStatisticsHydrationPlanV12,
  getPendingReadingSessionsV11,
  hydrateRemoteReadingSessionsPageV12,
  installReadingStatisticsBootstrap,
  markReadingSessionSyncedV11,
  reconcileUploadedReadingSessionConflictV11,
  recordReadingStatisticsHydrationMetricsV12,
  recordReadingStatisticsVerifiedAuditV12,
  PublishedReadingTailError,
  type ReadingStatisticsFullScanReason,
  type ReadingStatisticsRemoteCursorV12,
} from '../lib/localReadingStatistics';
import { getSyncOwnerKey, splitOwnerKey, type OwnerKey } from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getRemoteReadingSessionsPageV1,
  readReadingStatisticsClockSampleV1,
  readReadingStatisticsClockSampleSingleFlight,
  type ReadingStatisticsClockSample,
  uploadReadingSessionV1,
  verifyLegacyReadingStatisticsCursorV1,
  verifyRemoteReadingStatisticsAuditV1,
} from '../lib/readingStatisticsSync';
import {
  notifyReadingStatisticsChange,
  notifyReadingStatisticsServerCheck,
  requestReadingStatisticsRefresh,
  subscribeReadingStatisticsChanges,
  subscribeReadingStatisticsRefreshRequests,
  subscribeReadingStatisticsServerChecks,
} from '../lib/readingStatisticsWake';
import {
  readReadingStatisticsClockSample,
  writeReadingStatisticsClockSample,
} from '../lib/readingStatisticsClock';
import { isAuthSyncErrorCode, mergeSyncHealth, type SyncHealth } from '../lib/syncHealth';
import {
  READING_STATISTICS_LEASE_HEARTBEAT_MS,
  ReadingStatisticsSyncLeaseRuntime,
} from '../lib/readingStatisticsSyncLease';
import {
  catchUpReadingStatisticsAuditAsLeader,
  runReadingStatisticsHydrationAsLeader,
  type ReadingStatisticsHydrationPage,
} from '../lib/readingStatisticsSyncCoordinator';
import { createReadingStatisticsReceiveSchedule } from '../lib/readingStatisticsReceiveSchedule';
import { traceReaderBootstrap } from '../lib/readerBootstrapTrace';
import { parseReadingRollupBootstrap, type ReadingRollupCheckpoint, type ReadingUploadTime } from '../lib/readingRollupBootstrap';

const getErrorCode = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name || 'error' : 'error';
};

const getHealthForError = (error: unknown): SyncHealth => {
  const code = getErrorCode(error);
  if (isAuthSyncErrorCode(code)) return 'paused-auth';
  if (code === 'permission-denied') return 'blocked-permission';
  if (
    code === 'invalid-argument'
    || (error instanceof Error && /schema|identity|충돌/.test(error.message))
  ) return 'blocked-schema';
  return 'retrying-receive';
};

const allowPublishedAudit = process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS === '1';
const PUBLICATION_RECHECK_MS = 7 * 86_400_000;
const RECENT_HISTORY_MS = 14 * 86_400_000;

async function loadPublishedReadingBootstrap(owner: OwnerKey) {
  const { myPageRequest, MyPageRequestError } = await import('../lib/myPageSocialClient');
  try {
    const result = await myPageRequest<{ bootstrap: unknown }>({ view: 'rollup-bootstrap' }, {
      owner, signal: AbortSignal.timeout(8_000),
    });
    return parseReadingRollupBootstrap(result.bootstrap);
  } catch (error) {
    if (error instanceof MyPageRequestError && error.status === 404) return null;
    throw error;
  }
}

export const useReadingStatisticsSync = (
  user: FirebaseUser | null,
  ownerKey: OwnerKey | null,
) => {
  const [receiveHealth, setReceiveHealth] = useState<SyncHealth>('healthy');
  const [uploadHealth, setUploadHealth] = useState<SyncHealth>('healthy');
  const [quarantinedCount, setQuarantinedCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [lastServerCheckedAt, setLastServerCheckedAt] = useState<number | null>(null);
  const refreshOwnerKeyRef = useRef<OwnerKey | null>(null);

  const refresh = useCallback(() => {
    const currentOwnerKey = refreshOwnerKeyRef.current;
    if (currentOwnerKey) requestReadingStatisticsRefresh(currentOwnerKey);
  }, []);

  useEffect(() => {
    setReceiveHealth('healthy');
    setUploadHealth('healthy');
    setQuarantinedCount(0);
    setRefreshing(false);
    setLastServerCheckedAt(null);
    refreshOwnerKeyRef.current = null;
    if (!user || !ownerKey) return;
    const owner = ownerRuntime.capture();
    if (!owner || owner.ownerKey !== ownerKey) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    refreshOwnerKeyRef.current = syncOwnerKey;
    const leaseRuntime = new ReadingStatisticsSyncLeaseRuntime(
      syncOwnerKey,
      crypto.randomUUID(),
    );
    let disposed = false;
    let running = false;
    let receiving = false;
    let requested = false;
    let refreshRequested = true;
    let recoverRawRequested = false;
    let retryPublicationAt = 0;
    let retryTimer: number | null = null;
    let uploadRetryTimer: number | null = null;
    let leaderRetryTimer: number | null = null;
    let pollTimer: number | null = null;
    let receiveRetryCount = 0;
    const receiveSchedule = createReadingStatisticsReceiveSchedule();
    const clockSampleRequests = new Map<
      string,
      Promise<ReadingStatisticsClockSample | null>
    >();

    const isCurrent = () => !disposed && ownerRuntime.isCurrent(owner);
    const hasLeadership = async () => isCurrent() && await leaseRuntime.isCurrent();

    const scheduleLeaderRetry = () => {
      if (leaderRetryTimer !== null || !isCurrent()) return;
      leaderRetryTimer = window.setTimeout(() => {
        leaderRetryTimer = null;
        if (requested || refreshRequested) request(false);
      }, 2_000);
    };

    const scheduleRetry = () => {
      if (retryTimer !== null || !isCurrent()) return;
      const delay = Math.min(60_000, 2_000 * (2 ** Math.min(5, receiveRetryCount)));
      receiveRetryCount += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        request(true);
      }, delay);
    };

    const scheduleUploadRetry = (nextAttemptAt: number) => {
      if (!isCurrent()) return;
      if (uploadRetryTimer !== null) window.clearTimeout(uploadRetryTimer);
      uploadRetryTimer = window.setTimeout(() => {
        uploadRetryTimer = null;
        request(false);
      }, Math.max(0, nextAttemptAt - Date.now()));
    };

    const run = async () => {
      if (running || !isCurrent()) return;
      running = true;
      try {
        const lease = document.visibilityState === 'visible'
          ? await leaseRuntime.acquire()
          : null;
        if (
          !lease
          || !isCurrent()
          || document.visibilityState !== 'visible'
        ) {
          if (lease) await leaseRuntime.release();
          if (isCurrent() && document.visibilityState === 'visible') scheduleLeaderRetry();
          return;
        }
        const leaseClaim = leaseRuntime.claim;
        if (!leaseClaim) return;
        const hasClaimLeadership = async () => {
          const currentClaim = leaseRuntime.claim;
          return Boolean(
            currentClaim
            && currentClaim.holderTabId === leaseClaim.holderTabId
            && currentClaim.epoch === leaseClaim.epoch
            && await hasLeadership(),
          );
        };
        const uploadPending = async (limit?: number) => {
          const pending = await getPendingReadingSessionsV11(syncOwnerKey, Date.now(), limit);
          if (!await hasClaimLeadership()) return 'stopped';
          for (const session of pending) {
            if (!await hasClaimLeadership()) return 'stopped';
            try {
              const requestStartedAt = Date.now();
              const result = await uploadReadingSessionV1(db, user.uid, session);
              const requestCompletedAt = Date.now();
              if (!await hasClaimLeadership()) return 'stopped';
              if (result.status === 'conflict') {
                const reconciled = await reconcileUploadedReadingSessionConflictV11(
                  syncOwnerKey,
                  session,
                  result.remote,
                  leaseClaim,
                );
                if (!reconciled) return 'stopped';
                setUploadHealth('healthy');
                continue;
              }
              const markedSynced = await markReadingSessionSyncedV11(
                syncOwnerKey,
                session.sessionId,
                session,
                leaseClaim,
              );
              if (!markedSynced) return 'stopped';
              setUploadHealth('healthy');
              if (
                result.status === 'created'
                && !readReadingStatisticsClockSample(
                  session.deviceId,
                  localStorage,
                  requestCompletedAt,
                )
              ) {
                void readReadingStatisticsClockSampleSingleFlight(
                  clockSampleRequests,
                  session.deviceId,
                  async () => {
                    if (!await hasClaimLeadership()) return null;
                    const sample = await readReadingStatisticsClockSampleV1(
                      db,
                      user.uid,
                      session.sessionId,
                      requestStartedAt,
                      requestCompletedAt,
                    );
                    return await hasClaimLeadership() ? sample : null;
                  },
                ).then((sample) => {
                  if (sample && isCurrent()) {
                    writeReadingStatisticsClockSample(session.deviceId, sample);
                  }
                }).catch(() => undefined);
              }
            } catch (error) {
              if (!isCurrent()) return 'stopped';
              if (!await hasClaimLeadership()) return 'stopped';
              const nextHealth = getHealthForError(error);
              const nextAttemptAt = await deferReadingSessionSyncV11(
                syncOwnerKey,
                session.sessionId,
                getErrorCode(error),
                Date.now(),
                leaseClaim,
              );
              if (nextAttemptAt === null) return 'stopped';
              setUploadHealth(nextHealth);
              if (nextHealth === 'retrying-receive') scheduleUploadRetry(nextAttemptAt);
              if (nextHealth !== 'retrying-receive') return 'blocked';
            }
          }
          return 'ready';
        };
        do {
          requested = false;
          const shouldRefresh = refreshRequested;
          refreshRequested = false;
          let uploadStatus: Awaited<ReturnType<typeof uploadPending>> = 'ready';
          let uploadFailure: { error: unknown } | undefined;
          if (shouldRefresh) {
            const recoverRaw = recoverRawRequested;
            recoverRawRequested = false;
            receiving = true;
            setRefreshing(true);
            const hydrationStartedAt = performance.now();
            let interleavedUploadDurationMs = 0;
            let hydrationPageCount = 0;
            let remoteReadAttemptCount = 0;
            let remoteReadCount = 0;
            let returnedDocuments = 0;
            let receivedHistoryDocuments = 0;
            let emptyQueries = 0;
            let queryMode: 'cursor' | 'no-cursor' | 'unavailable' = 'unavailable';
            let auditProbe: 'matched' | 'mismatch' | 'failed' | undefined;
            let publishedAudit: boolean | undefined;
            let publishedBootstrap: 'installed' | 'resumed' | 'fallback' | undefined;
            let recentOnly = false;
            let fullScanReason: ReadingStatisticsFullScanReason | undefined;
            let hydrationStatus: 'completed' | 'lost-leadership' | 'failed' = 'failed';
            const instrumentation = {
              onReadAttempt: () => { remoteReadAttemptCount += 1; },
              onReadSuccess: (documents: number) => {
                remoteReadCount += 1;
                returnedDocuments += documents;
                if (documents === 0) emptyQueries += 1;
              },
            };
            try {
              let published: ReadingRollupCheckpoint | undefined;
              let timestampRangeOnly = false;
              const recentSince = Date.now() - RECENT_HISTORY_MS;
              const withinRecentTime = ({ seconds, nanoseconds }: ReadingUploadTime) =>
                seconds * 1000 + nanoseconds / 1_000_000 >= recentSince;
              const withinRecent = (cursor: ReadingStatisticsRemoteCursorV12 | null) => cursor !== null
                && withinRecentTime({ seconds: cursor.uploadedAtServerSeconds, nanoseconds: cursor.uploadedAtServerNanoseconds });
              const hydrationOperations = {
                isLeader: hasClaimLeadership,
                fetchPage: async (cursor: ReadingStatisticsRemoteCursorV12 | null, options?: { singleSnapshot: boolean }) => {
                  const page = await getRemoteReadingSessionsPageV1(db, user.uid, cursor, undefined, undefined, instrumentation, {
                    ...options,
                    timestampRangeOnly,
                    publishedThrough: published?.sourceThrough,
                    recentSince: recentOnly ? recentSince : undefined,
                    isLeader: hasClaimLeadership,
                  });
                  receivedHistoryDocuments += page.sessions.length + page.quarantinedDocuments.length;
                  return page;
                },
                commitPage: async (page: ReadingStatisticsHydrationPage, cursor: ReadingStatisticsRemoteCursorV12 | null) => {
                  const result = await hydrateRemoteReadingSessionsPageV12(
                    syncOwnerKey, page.sessions, cursor, page.nextCursor, page.fullHydrationCompleted,
                    false, page.quarantinedDocuments, Date.now(), leaseClaim, timestampRangeOnly,
                    published, recentOnly,
                  );
                  hydrationPageCount += 1;
                  return result;
                },
              };
              const loadPlan = (allow = allowPublishedAudit) => getReadingStatisticsHydrationPlanV12(syncOwnerKey, Date.now(), allow, true);
              let plan = await loadPlan();
              const recoverHistory = async () => {
                publishedBootstrap = 'fallback';
                fullScanReason ??= 'published-history-unavailable';
                published = undefined;
                if (!await beginReadingStatisticsRecentRecovery(syncOwnerKey, leaseClaim)) return false;
                recentOnly = true;
                timestampRangeOnly = true;
                plan = await loadPlan(false);
                return true;
              };
              const previousPublication = 'state' in plan ? plan.published : undefined;
              const initialBootstrap = allowPublishedAudit && !previousPublication && Date.now() >= retryPublicationAt
                && (!('state' in plan) || plan.recentOnly || plan.fullAuditInProgress || !withinRecent(plan.state.cursor));
              if (recoverRaw || ('reason' in plan && plan.reason === 'published-history-unavailable')) {
                if (!await recoverHistory()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
              } else if (initialBootstrap || (previousPublication
                && Date.now() >= Math.max(retryPublicationAt, previousPublication.checkedAt + PUBLICATION_RECHECK_MS))) {
                // Network failure leaves a previously verified publication usable.
                const bootstrap = await loadPublishedReadingBootstrap(syncOwnerKey).catch(() => undefined);
                retryPublicationAt = Date.now() + 60 * 60_000;
                if (!await hasClaimLeadership()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                if (bootstrap && withinRecentTime(bootstrap.sourceThrough) && await installReadingStatisticsBootstrap(
                  syncOwnerKey, bootstrap, leaseClaim, Date.now(), previousPublication, initialBootstrap,
                )) {
                  publishedBootstrap = previousPublication ? 'resumed' : 'installed';
                  plan = await loadPlan();
                } else if (previousPublication && bootstrap !== undefined && !await recoverHistory()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
              }
              const needsCoverage = ('candidate' in plan && plan.candidate.publishedAudit)
                || ('catchUpFrom' in plan && plan.catchUpFrom?.publishedAudit);
              if (needsCoverage) {
                const result = await import('../lib/myPageSocialClient').then(({ myPageRequest }) => (
                  myPageRequest<{ covered: boolean }>({ view: 'rollup-audit' }, {
                    owner: syncOwnerKey, signal: AbortSignal.timeout(8_000),
                  })
                )).catch(() => null);
                if (!await hasClaimLeadership()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                publishedAudit = result?.covered === true;
                if (!publishedAudit) plan = await loadPlan(false);
              }
              if ('legacyCursor' in plan && withinRecent(plan.legacyCursor)) {
                const { legacyCursor } = plan;
                if (!await hasClaimLeadership()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                const verified = await verifyLegacyReadingStatisticsCursorV1(db, user.uid, legacyCursor, instrumentation);
                if (verified) {
                  if (!await hasClaimLeadership()) {
                    hydrationStatus = 'lost-leadership';
                    refreshRequested = true;
                    return;
                  }
                  await adoptLegacyReadingStatisticsCursorV12(syncOwnerKey, legacyCursor, leaseClaim);
                  // Adopting a legacy cursor still needs a raw baseline.
                  plan = await loadPlan(false);
                  if ('legacyCursor' in plan) {
                    refreshRequested = true;
                    return;
                  }
                }
              }
              if ('catchUpFrom' in plan && plan.catchUpFrom && withinRecent(plan.catchUpFrom.cursor)) {
                const previous = plan.catchUpFrom;
                const caughtUpCount = await catchUpReadingStatisticsAuditAsLeader(previous.cursor, {
                  ...hydrationOperations,
                  verifyPreviousRange: () => verifyRemoteReadingStatisticsAuditV1(db, user.uid, previous, instrumentation)
                    .catch(() => false),
                });
                if (caughtUpCount > 0) {
                  notifyReadingStatisticsChange(syncOwnerKey);
                  const updated = await loadPlan(publishedAudit === true);
                  if (!('state' in updated)) plan = updated;
                }
              }
              let initialCursor = 'state' in plan ? plan.state.cursor : null;
              published = 'state' in plan ? plan.published : undefined;
              const publicationReceivePending = 'state' in plan && Boolean(published) && !plan.state.fullHydrationCompleted;
              if (published) publishedBootstrap ??= 'resumed';
              timestampRangeOnly = 'state' in plan && !plan.fullAuditInProgress;
              if ('candidate' in plan && withinRecent(plan.candidate.cursor)) {
                if (!await hasClaimLeadership()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                const candidate = plan.candidate;
                const verified = await verifyRemoteReadingStatisticsAuditV1(db, user.uid, candidate, instrumentation).catch(() => null);
                if (verified) {
                  auditProbe = 'matched';
                  if (await recordReadingStatisticsVerifiedAuditV12(syncOwnerKey, candidate, leaseClaim, Date.now, true)) {
                    initialCursor = candidate.cursor;
                    timestampRangeOnly = true;
                  } else {
                    fullScanReason = 'audit-checkpoint-changed';
                  }
                } else {
                  auditProbe = verified === null ? 'failed' : 'mismatch';
                  fullScanReason = verified === null ? 'remote-audit-failed' : 'remote-audit-mismatch';
                }
              } else if ('reason' in plan) {
                fullScanReason ??= plan.reason;
              }
              if ('state' in plan && plan.recentOnly) {
                recentOnly = true;
              } else if ((!timestampRangeOnly || !withinRecent(initialCursor) || ('state' in plan && !plan.state.lastFullAuditAt))
                && (!published || !withinRecentTime(published.sourceThrough))) {
                if (!await recoverHistory()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                initialCursor = 'state' in plan ? plan.state.cursor : null;
              }
              queryMode = initialCursor ? 'cursor' : 'no-cursor';
              const runHydration = () => runReadingStatisticsHydrationAsLeader({
                ...hydrationOperations,
                initialCursor,
                uploadBetweenPages: async (limit) => {
                  if (uploadStatus !== 'ready') return;
                  const uploadStartedAt = performance.now();
                  try {
                    uploadStatus = await uploadPending(limit);
                  } catch (error) {
                    // Finish hydration before propagating an unexpected upload failure.
                    uploadFailure = { error };
                    uploadStatus = 'blocked';
                  } finally {
                    interleavedUploadDurationMs += performance.now() - uploadStartedAt;
                  }
                },
              });
              let hydrationRun: Awaited<ReturnType<typeof runHydration>>;
              try {
                hydrationRun = await runHydration();
              } catch (error) {
                if (!(error instanceof PublishedReadingTailError)) throw error;
                if (!await hasClaimLeadership() || !await recoverHistory()) {
                  hydrationStatus = 'lost-leadership';
                  refreshRequested = true;
                  return;
                }
                fullScanReason = 'published-history-unavailable';
                initialCursor = 'state' in plan ? plan.state.cursor : null;
                timestampRangeOnly = true;
                queryMode = initialCursor ? 'cursor' : 'no-cursor';
                hydrationRun = await runHydration();
              }
              hydrationStatus = hydrationRun.status;
              if (hydrationRun.status === 'lost-leadership') {
                refreshRequested = true;
                return;
              }
              if (!await hasClaimLeadership()) {
                hydrationStatus = 'lost-leadership';
                refreshRequested = true;
                return;
              }
              setQuarantinedCount(hydrationRun.quarantinedCount);
              if (hydrationRun.hydratedCount > 0 || publicationReceivePending || publishedBootstrap === 'fallback') {
                notifyReadingStatisticsChange(syncOwnerKey);
              }
              const checkedAt = Date.now();
              const receivedRecords = receivedHistoryDocuments > 0;
              receiveSchedule.complete(checkedAt, receivedRecords);
              notifyReadingStatisticsServerCheck(syncOwnerKey, checkedAt, receivedRecords);
              if (retryTimer !== null) window.clearTimeout(retryTimer);
              retryTimer = null;
              receiveRetryCount = 0;
              setReceiveHealth('healthy');
            } catch (error) {
              if (!isCurrent()) return;
              if (!await hasClaimLeadership()) {
                hydrationStatus = 'lost-leadership';
                refreshRequested = true;
                return;
              }
              setReceiveHealth(getHealthForError(error));
              if (getHealthForError(error) === 'retrying-receive') scheduleRetry();
            } finally {
              receiving = false;
              traceReaderBootstrap({
                event: 'reading-statistics-hydration',
                status: hydrationStatus,
                queryMode,
                queryAttempts: remoteReadAttemptCount,
                completedQueries: remoteReadCount,
                returnedDocuments,
                emptyQueries,
                auditProbe,
                publishedAudit,
                publishedBootstrap,
                fullScanReason,
                recentOnly,
              });
              await recordReadingStatisticsHydrationMetricsV12(syncOwnerKey, {
                pageCount: hydrationPageCount,
                remoteReadAttemptCount,
                remoteReadCount,
                durationMs: Math.max(0, performance.now() - hydrationStartedAt - interleavedUploadDurationMs),
                status: hydrationStatus,
              }).catch((error) => {
                console.warn('[ReadingStatistics] hydration metrics persistence failed:', error);
              });
              if (hydrationStatus === 'failed') {
                notifyReadingStatisticsServerCheck(syncOwnerKey, null);
              }
              setRefreshing(false);
            }
          }

          if (uploadFailure) throw uploadFailure.error;
          if (uploadStatus === 'ready') uploadStatus = await uploadPending();
          if (uploadStatus === 'stopped') return;
        } while (requested && isCurrent());
      } finally {
        running = false;
        if ((requested || refreshRequested) && document.visibilityState === 'visible') scheduleLeaderRetry();
      }
    };

    function request(refresh: boolean) {
      if (!isCurrent()) return;
      requested = true;
      refreshRequested ||= refresh;
      queueMicrotask(() => void run());
    }

    const requestExplicitRefresh = () => {
      setRefreshing(true);
      request(true);
    };

    function schedulePoll() {
      if (!isCurrent()) return;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        if (navigator.onLine && document.visibilityState === 'visible'
          && !receiving && retryTimer === null && receiveSchedule.pollDue(Date.now())) request(true);
        schedulePoll();
      }, receiveSchedule.nextPollDelay(Date.now()));
    }

    const handleOnline = () => request(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        request(receiveSchedule.wakeDue(Date.now()));
      } else {
        void leaseRuntime.release();
      }
    };
    const unsubscribeChanges = subscribeReadingStatisticsChanges(
      syncOwnerKey,
      () => request(false),
    );
    const unsubscribeRefreshRequests = subscribeReadingStatisticsRefreshRequests(
      syncOwnerKey,
      (recoverRaw) => {
        if (recoverRaw) recoverRawRequested = true;
        requestExplicitRefresh();
      },
    );
    const unsubscribeServerChecks = subscribeReadingStatisticsServerChecks(
      syncOwnerKey,
      (checkedAt, receivedRecords) => {
        if (checkedAt !== null) {
          receiveSchedule.observeCheck(checkedAt, receivedRecords);
          schedulePoll();
          setLastServerCheckedAt((current) => Math.max(current ?? 0, checkedAt));
        }
        setRefreshing(false);
      },
    );
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid && !receiving) request(receiveSchedule.wakeDue(Date.now()));
    });
    schedulePoll();
    const heartbeatInterval = window.setInterval(() => {
      if (!isCurrent() || document.visibilityState !== 'visible') return;
      void leaseRuntime.acquire().then((lease) => {
        if (!isCurrent() || (!requested && !refreshRequested)) return;
        if (lease) request(false);
        else scheduleLeaderRetry();
      }).catch(() => scheduleLeaderRetry());
    }, READING_STATISTICS_LEASE_HEARTBEAT_MS);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    request(true);

    const unregister = ownerRuntime.registerDisposer(() => {
      disposed = true;
      void leaseRuntime.release();
    });
    return () => {
      disposed = true;
      if (refreshOwnerKeyRef.current === syncOwnerKey) {
        refreshOwnerKeyRef.current = null;
      }
      void leaseRuntime.release();
      unregister();
      unsubscribeChanges();
      unsubscribeRefreshRequests();
      unsubscribeServerChecks();
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      window.clearInterval(heartbeatInterval);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (uploadRetryTimer !== null) window.clearTimeout(uploadRetryTimer);
      if (leaderRetryTimer !== null) window.clearTimeout(leaderRetryTimer);
    };
  }, [ownerKey, user]);

  return {
    health: mergeSyncHealth(receiveHealth, uploadHealth),
    quarantinedCount,
    canRefresh: Boolean(user && ownerKey),
    refreshing,
    lastServerCheckedAt,
    refresh,
  };
};
