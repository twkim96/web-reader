import { useEffect, useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getSyncOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { applyProgressEventTransaction } from '../lib/progressSyncTransaction';
import { applyBookmarkEventTransaction } from '../lib/bookmarkSyncTransaction';
import { ProgressSyncWorker } from '../lib/progressSyncWorker';
import {
  getPausedSyncSummaryV5,
  isProgressOutboxEventV5,
  resumePausedAuthEventsV5,
} from '../lib/syncOutboxV5';
import { runProgressSyncPoll } from '../lib/progressSyncPolling';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';

export const useProgressSyncWorker = (
  user: FirebaseUser | null,
  ownerKey: string | null,
  deviceId: string,
) => {
  const [syncHealth, setSyncHealth] = useState<
    'healthy' | 'paused-auth' | 'blocked-permission' | 'blocked-schema'
  >('healthy');

  useEffect(() => {
    if (!user) {
      setSyncHealth('healthy');
      return;
    }
    const owner = ownerRuntime.capture();
    if (!owner) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);

    const worker = new ProgressSyncWorker(
      owner,
      crypto.randomUUID(),
      (event) => isProgressOutboxEventV5(event)
        ? applyProgressEventTransaction({
          event,
          uid: user.uid,
          firestore: db,
        })
        : applyBookmarkEventTransaction({
          event,
          uid: user.uid,
          firestore: db,
        }),
      {},
      syncOwnerKey,
    );
    let timer: number | undefined;
    let running = false;
    let disposed = false;

    const refreshHealth = async () => {
      const summary = await getPausedSyncSummaryV5(syncOwnerKey);
      if (disposed || !ownerRuntime.isCurrent(owner)) return;
      if (summary.count === 0) setSyncHealth('healthy');
      else if (summary.errorCodes.includes('unauthenticated')) setSyncHealth('paused-auth');
      else if (summary.errorCodes.includes('permission-denied')) setSyncHealth('blocked-permission');
      else setSyncHealth('blocked-schema');
    };

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
      if (document.visibilityState === 'hidden' && delay > 0) {
        timer = undefined;
        return;
      }
      timer = window.setTimeout(() => void pump(), delay);
    };
    const pump = async () => {
      if (disposed || running || !navigator.onLine) return;
      running = true;
      try {
        const nextDelay = await runProgressSyncPoll(
          () => worker.flushOne(),
          (error) => console.error('[ProgressSyncWorker] local polling failed:', error),
        );
        await refreshHealth();
        schedule(nextDelay);
      } finally {
        running = false;
      }
    };
    const handleOnline = () => {
      void resumePausedAuthEventsV5(syncOwnerKey).then(() => {
        schedule(0);
        return refreshHealth();
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') schedule(0);
    };
    const unsubscribeWork = subscribeProgressSyncWork(syncOwnerKey, () => schedule(0));
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    schedule(0);
    void resumePausedAuthEventsV5(syncOwnerKey).then(refreshHealth);

    const unregister = ownerRuntime.registerDisposer(() => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      void worker.dispose();
    });
    return () => {
      disposed = true;
      unregister();
      unsubscribeWork();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      if (timer !== undefined) window.clearTimeout(timer);
      void worker.dispose();
    };
  }, [deviceId, ownerKey, user]);

  return syncHealth;
};
