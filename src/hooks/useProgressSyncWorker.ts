import { useEffect } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getSyncOwnerKey,
  makeOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { getOwnerBindingsV5 } from '../lib/localDBV5';
import { applyProgressEventTransaction } from '../lib/progressSyncTransaction';
import { applyBookmarkEventTransaction } from '../lib/bookmarkSyncTransaction';
import { ProgressSyncWorker } from '../lib/progressSyncWorker';
import { isProgressOutboxEventV5 } from '../lib/syncOutboxV5';
import { migrateDriveProgressToFirebaseScopeV170 } from '../lib/firebaseSyncScopeMigrationV170';
import { runProgressSyncPoll } from '../lib/progressSyncPolling';

export const useProgressSyncWorker = (
  user: FirebaseUser | null,
  ownerKey: string | null,
  deviceId: string,
) => {
  useEffect(() => {
    if (!user) return;
    const owner = ownerRuntime.capture();
    if (!owner || owner.storageMode === 'legacy-readonly') return;
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
    const migrateKnownDriveScopes = async () => {
      const bindings = await getOwnerBindingsV5(authOwnerKey);
      const sourceOwnerKeys = new Set(bindings
        .filter(({ libraryScopeKey }) => libraryScopeKey.startsWith('drive:'))
        .map(({ libraryScopeKey }) => makeOwnerKey(authOwnerKey, libraryScopeKey)));
      const { libraryScopeKey } = splitOwnerKey(owner.ownerKey);
      if (libraryScopeKey.startsWith('drive:')) sourceOwnerKeys.add(owner.ownerKey);

      for (const sourceOwnerKey of sourceOwnerKeys) {
        if (disposed || !ownerRuntime.isCurrent(owner)) return;
        await migrateDriveProgressToFirebaseScopeV170({ sourceOwnerKey, deviceId });
      }
    };
    void migrateKnownDriveScopes().catch((error) => {
      console.error('[FirebaseSyncScopeV170] migration failed:', error);
    }).finally(() => schedule(0));

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
