import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import { APP_ID, auth, db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { RemoteProgressUpdate, UserProgress } from '../types';
import { getSyncOwnerKey, splitOwnerKey } from '../lib/ownerIdentity';
import {
  getFirebaseSyncHistoryPath,
  parseBookmarkHeadV2,
  parseProgressHeadV2,
} from '../lib/progressV2Schema';
import {
  recordRemoteBookmarkMissingV5,
  recordRemoteMissingV5,
  storeRemoteHeadsBatchV5,
} from '../lib/syncOutboxV5';
import {
  getTimestampMs,
} from './progressPolicy';
import {
  applyRemoteBookmarkHeadChanges,
  type RemoteBookmarkHeadChange,
} from '../lib/remoteBookmarkAccumulator';
import { hydrateRemoteBookmarkHeadsV5 } from '../lib/bookmarkSyncLocal';
import { rebaseProgressCommitBaseline } from '../lib/progressCommitBaseline';
import {
  mergeRemotePositionUpdates,
  type RemotePositionUpdate,
} from '../lib/remoteProgressState';
import { ServerSnapshotHydrator } from '../lib/serverSnapshotHydrator';
import { getSyncSessionId, isExactSyncSessionEcho } from '../lib/syncSession';
import { SnapshotListenerRecovery } from '../lib/snapshotListenerRecovery';
import { mergeSyncHealth, type SyncHealth } from '../lib/syncHealth';
import { traceReaderBootstrap } from '../lib/readerBootstrapTrace';

type FirestoreQuerySnapshot = QuerySnapshot<DocumentData, DocumentData>;

const AUTHORITATIVE_SNAPSHOT_STALE_MS = 15_000;

const reconcileSnapshotListener = <T,>(
  recovery: SnapshotListenerRecovery<T> | null,
  options?: { force?: boolean; now?: number },
) => {
  return recovery?.reconcile({
    force: options?.force,
    now: options?.now,
    staleAfterMs: AUTHORITATIVE_SNAPSHOT_STALE_MS,
  }) ?? false;
};

interface UseProgressSyncOptions {
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, RemoteProgressUpdate>>>;
  activeBookId?: string;
  ownerKey: string | null;
}

export const useProgressSync = ({
  user,
  deviceId,
  progressRef,
  setProgress,
  setRemoteProgress,
  activeBookId,
  ownerKey,
}: UseProgressSyncOptions) => {
  const progressRecoveryRef = useRef<SnapshotListenerRecovery<FirestoreQuerySnapshot> | null>(null);
  const bookmarkRecoveryRef = useRef<SnapshotListenerRecovery<FirestoreQuerySnapshot> | null>(null);
  const [progressReceiveHealth, setProgressReceiveHealth] = useState<SyncHealth>('healthy');
  const [bookmarkReceiveHealth, setBookmarkReceiveHealth] = useState<SyncHealth>('healthy');

  useEffect(() => {
    if (!user) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;

    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const syncSessionId = getSyncSessionId();
    const firebaseHistoryPath = getFirebaseSyncHistoryPath(APP_ID, user.uid);
    const v2Ref = collection(db, firebaseHistoryPath);

    let hydrator = new ServerSnapshotHydrator<
      QueryDocumentSnapshot<DocumentData, DocumentData>
    >();
    const handleSnapshot = async (snapshot: FirestoreQuerySnapshot) => {
      if (!ownerRuntime.isCurrent(owner)) return;
      if (!snapshot.metadata.fromCache) {
        traceReaderBootstrap({ event: 'authoritative-snapshot', listener: 'progress' });
      }
      const changes = hydrator.select(snapshot);
      if (!changes) return;
      const remoteUpdates: Record<string, RemotePositionUpdate> = {};
      const removedBookIds = new Set<string>();
      const heads = [];
      for (const change of changes) {
        if (change.doc.metadata.hasPendingWrites) continue;
        if (change.type === 'removed') {
          await recordRemoteMissingV5(syncOwnerKey, change.doc.id);
          removedBookIds.add(change.doc.id);
          continue;
        }
        try {
          const head = parseProgressHeadV2(change.doc.data());
          heads.push(head);
          if (isExactSyncSessionEcho(head.acceptedSessionId, syncSessionId)) continue;
          const serverTime = getTimestampMs(head.updatedAtServer, 0);
          remoteUpdates[head.bookId] = head.operation === 'reset'
            ? {
              operation: 'reset',
              bookId: head.bookId,
              cfi: '',
              anchorCfi: '',
              progressPercent: 0,
              lastRead: serverTime,
              syncRevision: head.revision,
              acceptedEventId: head.acceptedEventId,
            }
            : {
              operation: 'set',
              bookId: head.bookId,
              cfi: head.position!.cfi,
              anchorCfi: head.position!.anchorCfi ?? head.position!.cfi,
              progressPercent: head.position!.progressPercent,
              lastRead: serverTime,
              syncRevision: head.revision,
              acceptedEventId: head.acceptedEventId,
            };
        } catch (error) {
          console.error('[ProgressV2] Invalid remote head:', error);
        }
      }
      await storeRemoteHeadsBatchV5(syncOwnerKey, heads);
      if (!ownerRuntime.isCurrent(owner)) return;
      if (Object.keys(remoteUpdates).length === 0 && removedBookIds.size === 0) return;
      setRemoteProgress((prev) => mergeRemotePositionUpdates(
        prev,
        remoteUpdates,
        removedBookIds,
      ));
    };

    const recovery = new SnapshotListenerRecovery<FirestoreQuerySnapshot>({
      subscribe: (next, error) => {
        hydrator = new ServerSnapshotHydrator();
        traceReaderBootstrap({ event: 'listener-attached', listener: 'progress' });
        return onSnapshot(v2Ref, { includeMetadataChanges: true }, next, error);
      },
      onSnapshot: handleSnapshot,
      isAuthoritative: (snapshot) => !snapshot.metadata.fromCache,
      onHealthChange: setProgressReceiveHealth,
      onError: (error) => console.error('[ProgressV2] listener failed:', error),
      canRetry: () => navigator.onLine,
    });
    progressRecoveryRef.current = recovery;
    recovery.start();

    const dispose = () => {
      if (progressRecoveryRef.current === recovery) progressRecoveryRef.current = null;
      recovery.dispose();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [deviceId, ownerKey, progressRef, setRemoteProgress, user]);

  useEffect(() => {
    if (!user || !activeBookId) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;

    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const syncSessionId = getSyncSessionId();
    const firebaseHistoryPath = getFirebaseSyncHistoryPath(APP_ID, user.uid);
    let hydrator = new ServerSnapshotHydrator<
      QueryDocumentSnapshot<DocumentData, DocumentData>
    >();
    let remoteBookmarkHeads = new Map();
    const bookmarksRef = collection(doc(db, firebaseHistoryPath, activeBookId), 'bookmarks');
    const handleSnapshot = async (snapshot: FirestoreQuerySnapshot) => {
      if (!ownerRuntime.isCurrent(owner)) return;
      if (!snapshot.metadata.fromCache) {
        traceReaderBootstrap({ event: 'authoritative-snapshot', listener: 'bookmark' });
      }
      const changes = hydrator.select(snapshot);
      if (!changes) return;
      const accumulatedChanges: RemoteBookmarkHeadChange[] = [];
      for (const change of changes) {
        if (change.doc.metadata.hasPendingWrites) continue;
        if (change.type === 'removed') {
          accumulatedChanges.push({ type: 'remove', bookmarkId: change.doc.id });
          await recordRemoteBookmarkMissingV5(syncOwnerKey, activeBookId, change.doc.id);
          continue;
        }
        try {
          const head = parseBookmarkHeadV2(change.doc.data());
          accumulatedChanges.push({ type: 'upsert', head });
        } catch (error) {
          console.error('[BookmarkV2] Invalid remote head:', error);
        }
      }
      remoteBookmarkHeads = applyRemoteBookmarkHeadChanges(
        remoteBookmarkHeads,
        accumulatedChanges,
      );
      const hydrated = await hydrateRemoteBookmarkHeadsV5(
        syncOwnerKey,
        activeBookId,
        [...remoteBookmarkHeads.values()],
        syncSessionId,
        Date.now(),
        () => ownerRuntime.isCurrent(owner),
      );
      if (!hydrated.changed || !hydrated.progress || !ownerRuntime.isCurrent(owner)) return;
      rebaseProgressCommitBaseline(owner.ownerKey, activeBookId, hydrated.progress);
      progressRef.current = {
        ...progressRef.current,
        [activeBookId]: hydrated.progress,
      };
      setProgress((prev) => ownerRuntime.isCurrent(owner)
        ? { ...prev, [activeBookId]: hydrated.progress! }
        : prev);
    };

    const recovery = new SnapshotListenerRecovery<FirestoreQuerySnapshot>({
      subscribe: (next, error) => {
        hydrator = new ServerSnapshotHydrator();
        remoteBookmarkHeads = new Map();
        traceReaderBootstrap({ event: 'listener-attached', listener: 'bookmark' });
        return onSnapshot(
          bookmarksRef,
          { includeMetadataChanges: true },
          next,
          error,
        );
      },
      onSnapshot: handleSnapshot,
      isAuthoritative: (snapshot) => !snapshot.metadata.fromCache,
      onHealthChange: setBookmarkReceiveHealth,
      onError: (error) => console.error('[BookmarkV2] listener failed:', error),
      canRetry: () => navigator.onLine,
    });
    bookmarkRecoveryRef.current = recovery;
    recovery.start();

    const dispose = () => {
      if (bookmarkRecoveryRef.current === recovery) bookmarkRecoveryRef.current = null;
      recovery.dispose();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [activeBookId, deviceId, ownerKey, progressRef, setProgress, user]);

  useEffect(() => {
    if (!user) return;
    const reconcileListeners = (force = false) => {
      const now = Date.now();
      if (reconcileSnapshotListener(progressRecoveryRef.current, { force, now })) {
        traceReaderBootstrap({ event: 'listener-reconciled', listener: 'progress' });
      }
      if (reconcileSnapshotListener(bookmarkRecoveryRef.current, { force, now })) {
        traceReaderBootstrap({ event: 'listener-reconciled', listener: 'bookmark' });
      }
    };
    const handleOnline = () => reconcileListeners(true);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconcileListeners();
    };
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid) reconcileListeners();
    });
    // Opening another book recreates its bookmark listener. The account-wide
    // progress listener is longer-lived, so reconcile it when its last server
    // snapshot is old before ordinary quiet resume is allowed to act on it.
    if (activeBookId && reconcileSnapshotListener(
      progressRecoveryRef.current,
      { now: Date.now() },
    )) {
      traceReaderBootstrap({ event: 'listener-reconciled', listener: 'progress' });
    }
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeBookId, user]);

  return mergeSyncHealth(
    user ? progressReceiveHealth : 'healthy',
    user && activeBookId ? bookmarkReceiveHealth : 'healthy',
  );
};
