'use client';

import { useEffect, useState } from 'react';
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import {
  deferReadingSessionSyncV11,
  getReadingStatisticsHydrationStateV12,
  getPendingReadingSessionsV11,
  hydrateRemoteReadingSessionsPageV12,
  markReadingSessionSyncedV11,
  recordReadingStatisticsHydrationMetricsV12,
} from '../lib/localReadingStatistics';
import { getSyncOwnerKey, splitOwnerKey, type OwnerKey } from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getRemoteReadingSessionsPageV1,
  readReadingStatisticsClockSampleV1,
  readReadingStatisticsClockSampleSingleFlight,
  type ReadingStatisticsClockSample,
  uploadReadingSessionV1,
} from '../lib/readingStatisticsSync';
import {
  notifyReadingStatisticsChange,
  subscribeReadingStatisticsChanges,
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
import { runReadingStatisticsHydrationAsLeader } from '../lib/readingStatisticsSyncCoordinator';

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

export const useReadingStatisticsSync = (
  user: FirebaseUser | null,
  ownerKey: OwnerKey | null,
) => {
  const [receiveHealth, setReceiveHealth] = useState<SyncHealth>('healthy');
  const [uploadHealth, setUploadHealth] = useState<SyncHealth>('healthy');
  const [quarantinedCount, setQuarantinedCount] = useState(0);

  useEffect(() => {
    setReceiveHealth('healthy');
    setUploadHealth('healthy');
    setQuarantinedCount(0);
    if (!user || !ownerKey) return;
    const owner = ownerRuntime.capture();
    if (!owner || owner.ownerKey !== ownerKey) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const leaseRuntime = new ReadingStatisticsSyncLeaseRuntime(
      syncOwnerKey,
      crypto.randomUUID(),
    );
    let disposed = false;
    let running = false;
    let requested = false;
    let refreshRequested = true;
    let retryTimer: number | null = null;
    let uploadRetryTimer: number | null = null;
    let leaderRetryTimer: number | null = null;
    let receiveRetryCount = 0;
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
        request(true);
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
        do {
          requested = false;
          const shouldRefresh = refreshRequested;
          refreshRequested = false;
          if (shouldRefresh) {
            const hydrationStartedAt = performance.now();
            let hydrationPageCount = 0;
            let remoteReadAttemptCount = 0;
            let remoteReadCount = 0;
            let hydrationStatus: 'completed' | 'lost-leadership' | 'failed' = 'failed';
            try {
              const hydration = await getReadingStatisticsHydrationStateV12(syncOwnerKey);
              const hydrationRun = await runReadingStatisticsHydrationAsLeader({
                initialCursor: hydration?.cursor ?? null,
                isLeader: hasClaimLeadership,
                fetchPage: async (cursor) => {
                  const page = await getRemoteReadingSessionsPageV1(
                    db,
                    user.uid,
                    cursor,
                    undefined,
                    undefined,
                    {
                      onReadAttempt: () => {
                        remoteReadAttemptCount += 1;
                      },
                      onReadSuccess: () => {
                        remoteReadCount += 1;
                      },
                    },
                  );
                  return page;
                },
                commitPage: async (page, cursor) => {
                  const result = await hydrateRemoteReadingSessionsPageV12(
                    syncOwnerKey,
                    page.sessions,
                    cursor,
                    page.nextCursor,
                    page.fullHydrationCompleted,
                    false,
                    page.quarantinedDocuments,
                    Date.now(),
                    leaseClaim,
                  );
                  hydrationPageCount += 1;
                  return result;
                },
              });
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
              if (hydrationRun.hydratedCount > 0) {
                notifyReadingStatisticsChange(syncOwnerKey);
              }
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
              await recordReadingStatisticsHydrationMetricsV12(syncOwnerKey, {
                pageCount: hydrationPageCount,
                remoteReadAttemptCount,
                remoteReadCount,
                durationMs: Math.max(0, performance.now() - hydrationStartedAt),
                status: hydrationStatus,
              }).catch((error) => {
                console.warn('[ReadingStatistics] hydration metrics persistence failed:', error);
              });
            }
          }

          const pending = await getPendingReadingSessionsV11(syncOwnerKey);
          if (!await hasClaimLeadership()) return;
          for (const session of pending) {
            if (!await hasClaimLeadership()) return;
            try {
              const requestStartedAt = Date.now();
              const result = await uploadReadingSessionV1(db, user.uid, session);
              const requestCompletedAt = Date.now();
              if (!await hasClaimLeadership()) return;
              const markedSynced = await markReadingSessionSyncedV11(
                syncOwnerKey,
                session.sessionId,
                session,
                leaseClaim,
              );
              if (!markedSynced) return;
              setUploadHealth('healthy');
              if (
                result === 'created'
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
              if (!isCurrent()) return;
              if (!await hasClaimLeadership()) return;
              const nextHealth = getHealthForError(error);
              const nextAttemptAt = await deferReadingSessionSyncV11(
                syncOwnerKey,
                session.sessionId,
                getErrorCode(error),
                Date.now(),
                leaseClaim,
              );
              if (nextAttemptAt === null) return;
              setUploadHealth(nextHealth);
              if (nextHealth === 'retrying-receive') scheduleUploadRetry(nextAttemptAt);
              if (nextHealth !== 'retrying-receive') break;
            }
          }
        } while (requested && isCurrent());
      } finally {
        running = false;
      }
    };

    function request(refresh: boolean) {
      if (!isCurrent()) return;
      requested = true;
      refreshRequested ||= refresh;
      queueMicrotask(() => void run());
    }

    const handleOnline = () => request(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        request(true);
      } else {
        void leaseRuntime.release();
      }
    };
    const unsubscribeChanges = subscribeReadingStatisticsChanges(
      syncOwnerKey,
      () => request(false),
    );
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid) request(true);
    });
    const refreshInterval = window.setInterval(() => request(true), 60_000);
    const heartbeatInterval = window.setInterval(() => {
      if (!isCurrent() || document.visibilityState !== 'visible') return;
      void leaseRuntime.acquire().then((lease) => {
        if (!lease && isCurrent()) scheduleLeaderRetry();
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
      void leaseRuntime.release();
      unregister();
      unsubscribeChanges();
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(refreshInterval);
      window.clearInterval(heartbeatInterval);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (uploadRetryTimer !== null) window.clearTimeout(uploadRetryTimer);
      if (leaderRetryTimer !== null) window.clearTimeout(leaderRetryTimer);
    };
  }, [ownerKey, user]);

  return {
    health: mergeSyncHealth(receiveHealth, uploadHealth),
    quarantinedCount,
  };
};
