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
    let disposed = false;
    let running = false;
    let requested = false;
    let refreshRequested = true;
    let retryTimer: number | null = null;
    let uploadRetryTimer: number | null = null;
    let receiveRetryCount = 0;
    const clockSampleRequests = new Map<
      string,
      Promise<ReadingStatisticsClockSample | null>
    >();

    const isCurrent = () => !disposed && ownerRuntime.isCurrent(owner);

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
        do {
          requested = false;
          const shouldRefresh = refreshRequested;
          refreshRequested = false;
          if (shouldRefresh) {
            try {
              const hydration = await getReadingStatisticsHydrationStateV12(syncOwnerKey);
              let cursor = hydration?.cursor ?? null;
              let completed = false;
              let hydratedAny = false;
              while (!completed) {
                const page = await getRemoteReadingSessionsPageV1(db, user.uid, cursor);
                if (!isCurrent()) return;
                const hydrationResult = await hydrateRemoteReadingSessionsPageV12(
                  syncOwnerKey,
                  page.sessions,
                  cursor,
                  page.nextCursor,
                  page.fullHydrationCompleted,
                  false,
                  page.quarantinedDocuments,
                );
                if (!isCurrent()) return;
                setQuarantinedCount(hydrationResult.quarantinedDocuments.length);
                cursor = page.nextCursor;
                completed = page.fullHydrationCompleted;
                hydratedAny ||= page.sessions.length > 0;
              }
              if (hydratedAny) notifyReadingStatisticsChange(syncOwnerKey);
              receiveRetryCount = 0;
              setReceiveHealth('healthy');
            } catch (error) {
              if (!isCurrent()) return;
              setReceiveHealth(getHealthForError(error));
              if (getHealthForError(error) === 'retrying-receive') scheduleRetry();
            }
          }

          const pending = await getPendingReadingSessionsV11(syncOwnerKey);
          for (const session of pending) {
            if (!isCurrent()) return;
            try {
              const requestStartedAt = Date.now();
              const result = await uploadReadingSessionV1(db, user.uid, session);
              const requestCompletedAt = Date.now();
              if (!isCurrent()) return;
              await markReadingSessionSyncedV11(
                syncOwnerKey,
                session.sessionId,
                session,
              );
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
                  () => readReadingStatisticsClockSampleV1(
                    db,
                    user.uid,
                    session.sessionId,
                    requestStartedAt,
                    requestCompletedAt,
                  ),
                ).then((sample) => {
                  if (sample && isCurrent()) {
                    writeReadingStatisticsClockSample(session.deviceId, sample);
                  }
                }).catch(() => undefined);
              }
            } catch (error) {
              if (!isCurrent()) return;
              const nextHealth = getHealthForError(error);
              const nextAttemptAt = await deferReadingSessionSyncV11(
                syncOwnerKey,
                session.sessionId,
                getErrorCode(error),
              );
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
      if (document.visibilityState === 'visible') request(true);
    };
    const unsubscribeChanges = subscribeReadingStatisticsChanges(
      syncOwnerKey,
      () => request(false),
    );
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid) request(true);
    });
    const refreshInterval = window.setInterval(() => request(true), 60_000);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    request(true);

    const unregister = ownerRuntime.registerDisposer(() => {
      disposed = true;
    });
    return () => {
      disposed = true;
      unregister();
      unsubscribeChanges();
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(refreshInterval);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (uploadRetryTimer !== null) window.clearTimeout(uploadRetryTimer);
    };
  }, [ownerKey, user]);

  return {
    health: mergeSyncHealth(receiveHealth, uploadHealth),
    quarantinedCount,
  };
};
