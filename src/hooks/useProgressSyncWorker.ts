import { useEffect, useState } from 'react';
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
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
import { ProgressSyncPumpController } from '../lib/progressSyncPump';
import { isAuthSyncErrorCode, type SyncHealth } from '../lib/syncHealth';

export const useProgressSyncWorker = (
  user: FirebaseUser | null,
  ownerKey: string | null,
  deviceId: string,
) => {
  const [syncHealth, setSyncHealth] = useState<SyncHealth>('healthy');

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
    let disposed = false;

    const refreshHealth = async () => {
      const summary = await getPausedSyncSummaryV5(syncOwnerKey);
      if (disposed || !ownerRuntime.isCurrent(owner)) return;
      if (summary.count === 0) setSyncHealth('healthy');
      else if (summary.errorCodes.some(isAuthSyncErrorCode)) setSyncHealth('paused-auth');
      else if (summary.errorCodes.includes('permission-denied')) setSyncHealth('blocked-permission');
      else setSyncHealth('blocked-schema');
    };

    const pump = new ProgressSyncPumpController({
      poll: () => runProgressSyncPoll(
          () => worker.flushOne(),
          (error) => console.error('[ProgressSyncWorker] local polling failed:', error),
      ),
      refreshHealth,
      reportHealthError: (error) => console.error('[ProgressSyncWorker] health refresh failed:', error),
      isOnline: () => navigator.onLine,
      isVisible: () => document.visibilityState !== 'hidden',
    });
    const resumePausedAndRequest = async () => {
      if (disposed || !ownerRuntime.isCurrent(owner)) return;
      try {
        await resumePausedAuthEventsV5(syncOwnerKey);
      } catch (error) {
        console.error('[ProgressSyncWorker] paused event resume failed:', error);
      } finally {
        if (!disposed && ownerRuntime.isCurrent(owner)) pump.request();
      }
    };
    const handleOnline = () => {
      void resumePausedAndRequest();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void resumePausedAndRequest();
    };
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid) void resumePausedAndRequest();
    });
    const unsubscribeWork = subscribeProgressSyncWork(syncOwnerKey, () => pump.request());
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    void resumePausedAndRequest();

    const unregister = ownerRuntime.registerDisposer(() => {
      disposed = true;
      pump.dispose();
      void worker.dispose();
    });
    return () => {
      disposed = true;
      unregister();
      unsubscribeToken();
      unsubscribeWork();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      pump.dispose();
      void worker.dispose();
    };
  }, [deviceId, ownerKey, user]);

  return syncHealth;
};
