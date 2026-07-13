import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot } from 'firebase/firestore';
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
  storeRemoteBookmarkHeadV5,
  storeRemoteProgressHeadV5,
} from '../lib/syncOutboxV5';
import {
  getTimestampMs,
} from './progressPolicy';
import {
  applyRemoteBookmarkHeadChanges,
  mergeAccumulatedRemoteBookmarks,
  type RemoteBookmarkHeadChange,
} from '../lib/remoteBookmarkAccumulator';

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
  const snapshotTailRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!user) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;

    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (authOwnerKey !== `firebase:${user.uid}`) return;
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const firebaseHistoryPath = getFirebaseSyncHistoryPath(APP_ID, user.uid);
    const v2Ref = collection(db, firebaseHistoryPath);

    const enqueueSnapshot = (work: () => Promise<void>) => {
      snapshotTailRef.current = snapshotTailRef.current
        .catch(() => undefined)
        .then(work);
    };

    const unsubscribeV2 = onSnapshot(v2Ref, { includeMetadataChanges: true }, (snapshot) => {
      enqueueSnapshot(async () => {
        if (!ownerRuntime.isCurrent(owner) || snapshot.metadata.fromCache) return;
        const remoteUpdates: Record<string, UserProgress> = {};
        for (const change of snapshot.docChanges()) {
          if (change.doc.metadata.hasPendingWrites) continue;
          if (change.type === 'removed') {
            await recordRemoteMissingV5(syncOwnerKey, change.doc.id);
            continue;
          }
          try {
            const head = parseProgressHeadV2(change.doc.data());
            await storeRemoteProgressHeadV5(syncOwnerKey, head);
            if (head.acceptedDeviceId === deviceId.current) continue;
            const serverTime = getTimestampMs(head.updatedAtServer, 0);
            remoteUpdates[head.bookId] = head.operation === 'reset'
              ? {
                bookId: head.bookId,
                cfi: '',
                anchorCfi: '',
                progressPercent: 0,
                lastRead: serverTime,
                bookmarks: progressRef.current[head.bookId]?.bookmarks ?? [],
              }
              : {
                bookId: head.bookId,
                cfi: head.position!.cfi,
                anchorCfi: head.position!.anchorCfi ?? head.position!.cfi,
                progressPercent: head.position!.progressPercent,
                lastRead: serverTime,
                bookmarks: progressRef.current[head.bookId]?.bookmarks ?? [],
              };
          } catch (error) {
            console.error('[ProgressV2] Invalid remote head:', error);
          }
        }
        if (!ownerRuntime.isCurrent(owner) || Object.keys(remoteUpdates).length === 0) return;
        setRemoteProgress((prev) => ({ ...prev, ...remoteUpdates }));
      });
    }, (error) => console.error('[ProgressV2] listener failed:', error));

    let remoteBookmarkHeads = new Map();
    const unsubscribeBookmarks = activeBookId
      ? onSnapshot(
        collection(doc(db, firebaseHistoryPath, activeBookId), 'bookmarks'),
        { includeMetadataChanges: true },
        (snapshot) => {
          enqueueSnapshot(async () => {
            if (!ownerRuntime.isCurrent(owner) || snapshot.metadata.fromCache) return;
            const current = progressRef.current[activeBookId]?.bookmarks ?? [];
            let changed = false;
            const accumulatedChanges: RemoteBookmarkHeadChange[] = [];
            for (const change of snapshot.docChanges()) {
              if (change.doc.metadata.hasPendingWrites) continue;
              if (change.type === 'removed') {
                accumulatedChanges.push({ type: 'remove', bookmarkId: change.doc.id });
                await recordRemoteBookmarkMissingV5(
                  syncOwnerKey,
                  activeBookId,
                  change.doc.id,
                );
                continue;
              }
              try {
                const head = parseBookmarkHeadV2(change.doc.data());
                await storeRemoteBookmarkHeadV5(syncOwnerKey, head);
                accumulatedChanges.push({ type: 'upsert', head });
                if (head.acceptedDeviceId === deviceId.current) continue;
                changed = true;
              } catch (error) {
                console.error('[BookmarkV2] Invalid remote head:', error);
              }
            }
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
      )
      : () => undefined;

    const dispose = () => {
      unsubscribeV2();
      unsubscribeBookmarks();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [activeBookId, deviceId, ownerKey, progressRef, setRemoteProgress, user]);
};
