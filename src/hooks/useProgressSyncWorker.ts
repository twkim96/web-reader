import { useEffect } from 'react';
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
import { isProgressOutboxEventV5 } from '../lib/syncOutboxV5';
import { runProgressSyncPoll } from '../lib/progressSyncPolling';

export const useProgressSyncWorker = (
  user: FirebaseUser | null,
  ownerKey: string | null,
  deviceId: string,
) => {
  useEffect(() => {
    if (!user) return;
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

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== undefined) window.clearTimeout(timer);
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
        schedule(nextDelay);
      } finally {
        running = false;
      }
    };
    const handleOnline = () => schedule(0);
    window.addEventListener('online', handleOnline);
    schedule(0);

    const unregister = ownerRuntime.registerDisposer(() => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      void worker.dispose();
    });
    return () => {
      disposed = true;
      unregister();
      window.removeEventListener('online', handleOnline);
      if (timer !== undefined) window.clearTimeout(timer);
      void worker.dispose();
    };
  }, [deviceId, ownerKey, user]);
};
