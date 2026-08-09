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
  mergeAccumulatedRemoteBookmarks,
  type RemoteBookmarkHeadChange,
} from '../lib/remoteBookmarkAccumulator';
import { ServerSnapshotHydrator } from '../lib/serverSnapshotHydrator';
import { getSyncSessionId, isExactSyncSessionEcho } from '../lib/syncSession';
import { SnapshotListenerRecovery } from '../lib/snapshotListenerRecovery';
import { mergeSyncHealth, type SyncHealth } from '../lib/syncHealth';

type FirestoreQuerySnapshot = QuerySnapshot<DocumentData, DocumentData>;

interface UseProgressSyncOptions {
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, RemoteProgressUpdate>>>;
  activeBookId?: string;
  ownerKey: string | null;
}

export const useProgressSync = ({
  user,
  deviceId,
  progressRef,
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
      const changes = hydrator.select(snapshot);
      if (!changes) return;
      const remoteUpdates: Record<string, RemoteProgressUpdate> = {};
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
              bookmarks: progressRef.current[head.bookId]?.bookmarks ?? [],
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
              bookmarks: progressRef.current[head.bookId]?.bookmarks ?? [],
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
      setRemoteProgress((prev) => {
        const next = { ...prev, ...remoteUpdates };
        for (const bookId of removedBookIds) delete next[bookId];
        return next;
      });
    };

    const recovery = new SnapshotListenerRecovery<FirestoreQuerySnapshot>({
      subscribe: (next, error) => {
        hydrator = new ServerSnapshotHydrator();
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
      const changes = hydrator.select(snapshot);
      if (!changes) return;
      const current = progressRef.current[activeBookId]?.bookmarks ?? [];
      let changed = false;
      const heads = [];
      const accumulatedChanges: RemoteBookmarkHeadChange[] = [];
      for (const change of changes) {
        if (change.doc.metadata.hasPendingWrites) continue;
        if (change.type === 'removed') {
          changed = true;
          accumulatedChanges.push({ type: 'remove', bookmarkId: change.doc.id });
          await recordRemoteBookmarkMissingV5(syncOwnerKey, activeBookId, change.doc.id);
          continue;
        }
        try {
          const head = parseBookmarkHeadV2(change.doc.data());
          heads.push(head);
          accumulatedChanges.push({ type: 'upsert', head });
          if (!isExactSyncSessionEcho(head.acceptedSessionId, syncSessionId)) changed = true;
        } catch (error) {
          console.error('[BookmarkV2] Invalid remote head:', error);
        }
      }
      await storeRemoteHeadsBatchV5(syncOwnerKey, heads);
      remoteBookmarkHeads = applyRemoteBookmarkHeadChanges(
        remoteBookmarkHeads,
        accumulatedChanges,
      );
      if (!changed || !ownerRuntime.isCurrent(owner)) return;
      setRemoteProgress((prev) => ({
        ...prev,
        [activeBookId]: {
          ...(prev[activeBookId] ?? progressRef.current[activeBookId] ?? {
            bookId: activeBookId,
            cfi: '',
            progressPercent: 0,
            lastRead: 0,
          }),
          bookmarks: mergeAccumulatedRemoteBookmarks(current, remoteBookmarkHeads),
        },
      }));
    };

    const recovery = new SnapshotListenerRecovery<FirestoreQuerySnapshot>({
      subscribe: (next, error) => {
        hydrator = new ServerSnapshotHydrator();
        remoteBookmarkHeads = new Map();
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
  }, [activeBookId, deviceId, ownerKey, progressRef, setRemoteProgress, user]);

  useEffect(() => {
    if (!user) return;
    const retryFailedListeners = () => {
      progressRecoveryRef.current?.retryNow();
      bookmarkRecoveryRef.current?.retryNow();
    };
    const handleOnline = () => retryFailedListeners();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') retryFailedListeners();
    };
    const unsubscribeToken = onIdTokenChanged(auth, (currentUser) => {
      if (currentUser?.uid === user.uid) retryFailedListeners();
    });
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [user]);

  return mergeSyncHealth(
    user ? progressReceiveHealth : 'healthy',
    user && activeBookId ? bookmarkReceiveHealth : 'healthy',
  );
};
