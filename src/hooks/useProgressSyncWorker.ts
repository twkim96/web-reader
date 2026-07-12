import { useEffect } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { splitOwnerKey } from '../lib/ownerIdentity';
import { applyProgressEventTransaction } from '../lib/progressSyncTransaction';
import { applyBookmarkEventTransaction } from '../lib/bookmarkSyncTransaction';
import { ProgressSyncWorker } from '../lib/progressSyncWorker';
import { isProgressOutboxEventV5 } from '../lib/syncOutboxV5';

const ACTIVE_DELAY_MS = 100;
const IDLE_DELAY_MS = 2_000;

export const useProgressSyncWorker = (user: FirebaseUser | null, ownerKey: string | null) => {
  useEffect(() => {
    if (!user) return;
    const owner = ownerRuntime.capture();
    if (!owner || owner.storageMode === 'legacy-readonly') return;
    const { authOwnerKey, libraryScopeKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;

    const worker = new ProgressSyncWorker(
      owner,
      crypto.randomUUID(),
      (event) => isProgressOutboxEventV5(event)
        ? applyProgressEventTransaction({
          event,
          uid: user.uid,
          libraryScopeKey,
          firestore: db,
        })
        : applyBookmarkEventTransaction({
          event,
          uid: user.uid,
          libraryScopeKey,
          firestore: db,
        }),
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
        const result = await worker.flushOne();
        const active = result === 'apply' || result === 'already_applied';
        schedule(active ? ACTIVE_DELAY_MS : IDLE_DELAY_MS);
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
  }, [ownerKey, user]);
};
