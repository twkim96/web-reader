import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { UserProgress } from '../types';
import { splitOwnerKey } from '../lib/ownerIdentity';
import { getV2HistoryPath, parseProgressHeadV2 } from '../lib/progressV2Schema';
import { recordRemoteMissingV5, storeRemoteProgressHeadV5 } from '../lib/syncOutboxV5';
import {
  getTimestampMs,
  mergeRemoteManualWithLocalAuto,
  RemoteProgressDoc,
  toProgressPercent,
} from './progressPolicy';

interface UseProgressSyncOptions {
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
}

export const useProgressSync = ({
  user,
  deviceId,
  progressRef,
  setRemoteProgress,
}: UseProgressSyncOptions) => {
  const snapshotTailRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!user) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;
    if (owner.storageMode === 'legacy-readonly') return;

    const { libraryScopeKey } = splitOwnerKey(owner.ownerKey);
    const v2Ref = collection(db, getV2HistoryPath(APP_ID, user.uid, libraryScopeKey));
    const v1Ref = collection(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory');

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
            await recordRemoteMissingV5(owner.ownerKey, change.doc.id);
            continue;
          }
          try {
            const head = parseProgressHeadV2(change.doc.data());
            await storeRemoteProgressHeadV5(owner.ownerKey, head);
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

    const unsubscribeV1 = onSnapshot(v1Ref, { includeMetadataChanges: true }, (snapshot) => {
      enqueueSnapshot(async () => {
        if (!ownerRuntime.isCurrent(owner) || snapshot.metadata.fromCache) return;
        const legacyCandidates: Record<string, UserProgress> = {};
        for (const change of snapshot.docChanges()) {
          if (change.type === 'removed' || change.doc.metadata.hasPendingWrites) continue;
          const raw = change.doc.data() as RemoteProgressDoc;
          const bookId = raw.bookId || change.doc.id;
          const localBookmarks = progressRef.current[bookId]?.bookmarks ?? [];
          legacyCandidates[bookId] = {
            bookId,
            cfi: raw.cfi || '',
            anchorCfi: raw.anchorCfi || raw.cfi || '',
            progressPercent: toProgressPercent(raw.progressPercent) ?? 0,
            lastRead: getTimestampMs(raw.lastRead, 0),
            bookmarks: mergeRemoteManualWithLocalAuto(raw.bookmarks || [], localBookmarks),
          };
        }
        if (!ownerRuntime.isCurrent(owner) || Object.keys(legacyCandidates).length === 0) return;
        setRemoteProgress((prev) => ({ ...prev, ...legacyCandidates }));
      });
    }, (error) => console.error('[ProgressV1Bridge] listener failed:', error));

    const dispose = () => {
      unsubscribeV2();
      unsubscribeV1();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [deviceId, progressRef, setRemoteProgress, user]);
};
