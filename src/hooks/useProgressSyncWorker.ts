import { useEffect, useState } from 'react';
import { onIdTokenChanged, type User as FirebaseUser } from 'firebase/auth';
import { auth, db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useOwnerSnapshot } from './useOwnerSnapshot';
import {
  GUEST_INSTALL_ID_KEY,
  getSyncOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { restoreGuestReadingToAccountV5 } from '../lib/localDBV5';
import { applyProgressEventTransaction } from '../lib/progressSyncTransaction';
import { applyBookmarkEventTransaction } from '../lib/bookmarkSyncTransaction';
import {
  applyAnnotationEventTransaction,
  applyAnnotationPaletteEventTransaction,
} from '../lib/annotationSyncTransaction';
import { ProgressSyncWorker } from '../lib/progressSyncWorker';
import {
  bindPendingSyncAuthorityV5,
  getPausedSyncSummaryV5,
  isAnnotationOutboxEventV5,
  isAnnotationPaletteOutboxEventV5,
  isBookmarkOutboxEventV5,
  isProgressOutboxEventV5,
  resumePausedAuthEventsV5,
} from '../lib/syncOutboxV5';
import { runProgressSyncPoll } from '../lib/progressSyncPolling';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';
import { ProgressSyncPumpController } from '../lib/progressSyncPump';
import { getPausedWriteSyncState, type SyncHealth } from '../lib/syncHealth';
import { getSyncSessionId } from '../lib/syncSession';
import { reconcileAnnotationBookDeletionIntentsV10 } from '../lib/annotationBookDeletion';
import { assertEventWriteLease, finiteWriteLeasesEnabled, getTrustedWriteLeaseTime, prepareWriteLease, requestReceiptMaintenance } from '../lib/writeLeaseTransport';
import {
  listExpiredSyncRecoveryTargets,
  recoverExpiredSyncTargetFromServer,
  type ExpiredSyncProgressUpdate,
} from '../lib/expiredSyncRecovery';

export const useProgressSyncWorker = (
  user: FirebaseUser | null,
  ownerKey: string | null,
  deviceId: string,
) => {
  const owner = useOwnerSnapshot();
  const [state, setState] = useState<{ health: SyncHealth; recoveryAvailable: boolean }>({ health: 'healthy', recoveryAvailable: false });

  useEffect(() => {
    if (!user) {
      setState({ health: 'healthy', recoveryAvailable: false });
      return;
    }
    if (!owner || owner.ownerKey !== ownerKey) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const annotationContext = {
      deviceId,
      sessionId: getSyncSessionId(),
    };
    let disposed = false;
    const recoverTarget = async (target: Parameters<typeof recoverExpiredSyncTargetFromServer>[2]) => {
      const isCurrent = () => !disposed && ownerRuntime.isCurrent(owner);
      const recovered = await recoverExpiredSyncTargetFromServer(user.uid, syncOwnerKey, target, {
        isCurrent,
        serverTrustedNow: getTrustedWriteLeaseTime(syncOwnerKey),
      });
      if (!isCurrent() || recovered.status !== 'resynced' || !recovered.progress) return;
      if (target.kind !== 'progress' && target.kind !== 'bookmark') return;
      let progress = recovered.progress;
      const guestId = target.kind === 'progress' ? localStorage.getItem(GUEST_INSTALL_ID_KEY) : null;
      if (guestId) {
        const guestOwner = makeOwnerKey(makeGuestOwnerKey(guestId), 'library:local');
        const imported = await restoreGuestReadingToAccountV5(
          syncOwnerKey, guestOwner, deviceId, annotationContext.sessionId, isCurrent, target.bookId,
        ).catch((error) => {
          console.warn('[ProgressSync] Guest position remains pending:', error);
          return undefined;
        });
        if (!isCurrent()) return;
        if (imported) progress = imported;
      }
      const detail: ExpiredSyncProgressUpdate = {
        ownerKey: syncOwnerKey,
        progress,
        ...(target.kind === 'bookmark' ? { kind: 'bookmark', bookmarkId: target.bookmarkId } : { kind: 'progress' }),
      };
      window.dispatchEvent(new CustomEvent('web-reader-expired-sync-progress', { detail }));
    };

    const worker = new ProgressSyncWorker(
      owner,
      crypto.randomUUID(),
      async (event) => {
        if (finiteWriteLeasesEnabled()) {
          try { assertEventWriteLease(event.eventId, syncOwnerKey); } catch (error) {
            if ((error as { code?: string }).code !== 'sync/write-lease-expired') throw error;
            await recoverTarget(event.target);
            throw error;
          }
        }
        if (isProgressOutboxEventV5(event)) return applyProgressEventTransaction({
          event,
          uid: user.uid,
          firestore: db,
        });
        if (isBookmarkOutboxEventV5(event)) return applyBookmarkEventTransaction({
          event,
          uid: user.uid,
          firestore: db,
        });
        if (isAnnotationOutboxEventV5(event)) return applyAnnotationEventTransaction({
          event,
          uid: user.uid,
          firestore: db,
        });
        if (isAnnotationPaletteOutboxEventV5(event)) {
          return applyAnnotationPaletteEventTransaction({
            event,
            uid: user.uid,
            firestore: db,
          });
        }
        throw new Error('지원하지 않는 동기화 event입니다.');
      },
      {},
      syncOwnerKey,
    );

    let recovering: Promise<void> | null = null;
    let lastRecoveryAttempt = 0;
    const recoverPending = async (force = false) => {
      if (!finiteWriteLeasesEnabled() || disposed || !ownerRuntime.isCurrent(owner)) return;
      if (recovering) return recovering;
      if (!force && Date.now() - lastRecoveryAttempt < 30_000) return;
      lastRecoveryAttempt = Date.now();
      const work = (async () => {
        for (const target of await listExpiredSyncRecoveryTargets(syncOwnerKey, getTrustedWriteLeaseTime(syncOwnerKey))) {
          if (disposed || !ownerRuntime.isCurrent(owner)) return;
          try {
            await recoverTarget(target);
          } catch (error) {
            console.error('[ProgressSyncWorker] expired target recovery failed:', error);
          }
        }
      })();
      recovering = work;
      try { await work; } finally { if (recovering === work) recovering = null; }
    };

    const refreshHealth = async () => {
      const summary = await getPausedSyncSummaryV5(syncOwnerKey);
      if (disposed || !ownerRuntime.isCurrent(owner)) return;
      const recoveryPending = finiteWriteLeasesEnabled() && (await listExpiredSyncRecoveryTargets(syncOwnerKey, getTrustedWriteLeaseTime(syncOwnerKey))).length > 0;
      if (disposed || !ownerRuntime.isCurrent(owner)) return;
      if (summary.count === 0) setState({ health: recoveryPending ? 'recovering-expired' : 'healthy', recoveryAvailable: false });
      else setState(getPausedWriteSyncState(summary.errorCodes));
    };

    let maintenance: Promise<void> | null = null;
    let nextMaintenanceAt = 0;
    const requestLeaderMaintenance = () => {
      if (maintenance || disposed || !ownerRuntime.isCurrent(owner) || Date.now() < nextMaintenanceAt) return;
      nextMaintenanceAt = Date.now() + 5_000;
      maintenance = (async () => {
        try {
          await reconcileAnnotationBookDeletionIntentsV10(user.uid, syncOwnerKey, annotationContext);
        } catch (error) {
          console.error('[AnnotationSync] book deletion reconciliation failed:', error);
        }
      })().finally(() => { maintenance = null; });
    };

    const pump = new ProgressSyncPumpController({
      poll: () => runProgressSyncPoll(
          async () => {
            if (finiteWriteLeasesEnabled()) {
              await prepareWriteLease(db, user.uid, syncOwnerKey, deviceId);
              if (disposed || !ownerRuntime.isCurrent(owner)) return 'stale_owner';
              await bindPendingSyncAuthorityV5(syncOwnerKey, () => !disposed && ownerRuntime.isCurrent(owner));
            }
            await recoverPending();
            return worker.flushOne(undefined, requestLeaderMaintenance);
          },
          (error) => console.error('[ProgressSyncWorker] local polling failed:', error),
      ),
      refreshHealth,
      reportHealthError: (error) => console.error('[ProgressSyncWorker] health refresh failed:', error),
      isOnline: () => navigator.onLine,
      isVisible: () => document.visibilityState !== 'hidden',
    });
    const resumePausedAndRequest = async (retryPermissionDenied = false) => {
      if (disposed || !ownerRuntime.isCurrent(owner) || navigator.onLine === false) return;
      try {
        if (finiteWriteLeasesEnabled()) {
          await prepareWriteLease(db, user.uid, syncOwnerKey, deviceId);
          if (disposed || !ownerRuntime.isCurrent(owner)) return;
          await bindPendingSyncAuthorityV5(syncOwnerKey, () => !disposed && ownerRuntime.isCurrent(owner));
          void requestReceiptMaintenance(user.uid, () => user.getIdToken()).catch(() => undefined);
          await recoverPending(true);
        }
        await resumePausedAuthEventsV5(syncOwnerKey, Date.now(), retryPermissionDenied);
      } catch (error) {
        console.error('[ProgressSyncWorker] paused event resume failed:', error);
      } finally {
        if (!disposed && ownerRuntime.isCurrent(owner)) pump.request();
      }
    };
    const handleOnline = () => {
      void resumePausedAndRequest(true);
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
    void resumePausedAndRequest(true);

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
  }, [deviceId, owner, ownerKey, user]);

  return state;
};
