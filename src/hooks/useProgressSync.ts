import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { UserProgress } from '../types';
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

interface UseProgressSyncOptions {
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
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
  const progressSnapshotTailRef = useRef(Promise.resolve());
  const bookmarkSnapshotTailRef = useRef(Promise.resolve());

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

    const hydrator = new ServerSnapshotHydrator<
      QueryDocumentSnapshot<DocumentData, DocumentData>
    >();
    const enqueueSnapshot = (work: () => Promise<void>) => {
      progressSnapshotTailRef.current = progressSnapshotTailRef.current
        .catch(() => undefined)
        .then(work);
    };

    const unsubscribeV2 = onSnapshot(v2Ref, { includeMetadataChanges: true }, (snapshot) => {
      enqueueSnapshot(async () => {
        if (!ownerRuntime.isCurrent(owner)) return;
        const changes = hydrator.select(snapshot);
        if (!changes) return;
        const remoteUpdates: Record<string, UserProgress> = {};
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
      });
    }, (error) => console.error('[ProgressV2] listener failed:', error));

    const dispose = () => {
      unsubscribeV2();
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
    const hydrator = new ServerSnapshotHydrator<
      QueryDocumentSnapshot<DocumentData, DocumentData>
    >();
    let remoteBookmarkHeads = new Map();
    const enqueueSnapshot = (work: () => Promise<void>) => {
      bookmarkSnapshotTailRef.current = bookmarkSnapshotTailRef.current
        .catch(() => undefined)
        .then(work);
    };

    const unsubscribe = onSnapshot(
      collection(doc(db, firebaseHistoryPath, activeBookId), 'bookmarks'),
      { includeMetadataChanges: true },
      (snapshot) => {
        enqueueSnapshot(async () => {
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
        });
      },
      (error) => console.error('[BookmarkV2] listener failed:', error),
    );

    const unregister = ownerRuntime.registerDisposer(unsubscribe);
    return () => {
      unregister();
      unsubscribe();
    };
  }, [activeBookId, deviceId, ownerKey, progressRef, setRemoteProgress, user]);
};
