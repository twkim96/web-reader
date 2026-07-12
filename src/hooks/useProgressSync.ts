import { Dispatch, MutableRefObject, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { ownerRuntime } from '../lib/ownerRuntime';
import { UserProgress } from '../types';
import { splitOwnerKey } from '../lib/ownerIdentity';
import { getV2HistoryPath, parseBookmarkHeadV2, parseProgressHeadV2 } from '../lib/progressV2Schema';
import {
  recordRemoteBookmarkMissingV5,
  recordRemoteMissingV5,
  storeRemoteBookmarkHeadV5,
  storeRemoteProgressHeadV5,
} from '../lib/syncOutboxV5';
import {
  claimLegacyV1CandidateV5,
  fingerprintLegacyV1Document,
} from '../lib/legacyV1Bridge';
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
          const fingerprint = fingerprintLegacyV1Document(bookId, raw);
          if (!await claimLegacyV1CandidateV5(owner.ownerKey, bookId, fingerprint)) continue;
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

    const unsubscribeBookmarks = activeBookId
      ? onSnapshot(
        collection(doc(db, getV2HistoryPath(APP_ID, user.uid, libraryScopeKey), activeBookId), 'bookmarks'),
        { includeMetadataChanges: true },
        (snapshot) => {
          enqueueSnapshot(async () => {
            if (!ownerRuntime.isCurrent(owner) || snapshot.metadata.fromCache) return;
            const current = progressRef.current[activeBookId]?.bookmarks ?? [];
            const manual = new Map(current
              .filter((bookmark) => bookmark.type === 'manual')
              .map((bookmark) => [bookmark.id, bookmark]));
            let changed = false;
            for (const change of snapshot.docChanges()) {
              if (change.doc.metadata.hasPendingWrites) continue;
              if (change.type === 'removed') {
                await recordRemoteBookmarkMissingV5(
                  owner.ownerKey,
                  activeBookId,
                  change.doc.id,
                );
                continue;
              }
              try {
                const head = parseBookmarkHeadV2(change.doc.data());
                await storeRemoteBookmarkHeadV5(owner.ownerKey, head);
                if (head.acceptedDeviceId === deviceId.current) continue;
                changed = true;
                if (head.operation === 'delete') {
                  manual.delete(head.bookmarkId);
                } else {
                  manual.set(head.bookmarkId, {
                    id: head.bookmarkId,
                    type: 'manual',
                    name: head.bookmark!.name,
                    cfi: head.bookmark!.cfi,
                    progressPercent: head.bookmark!.progressPercent ?? undefined,
                    createdAt: head.bookmark!.createdAtClient,
                    color: head.bookmark!.color,
                  });
                }
              } catch (error) {
                console.error('[BookmarkV2] Invalid remote head:', error);
              }
            }
            if (!changed || !ownerRuntime.isCurrent(owner)) return;
            const auto = current.filter((bookmark) => bookmark.type === 'auto');
            setRemoteProgress((prev) => ({
              ...prev,
              [activeBookId]: {
                ...(prev[activeBookId] ?? progressRef.current[activeBookId] ?? {
                  bookId: activeBookId,
                  cfi: '',
                  progressPercent: 0,
                  lastRead: 0,
                }),
                bookmarks: [...manual.values(), ...auto],
              },
            }));
          });
        },
        (error) => console.error('[BookmarkV2] listener failed:', error),
      )
      : () => undefined;

    const dispose = () => {
      unsubscribeV2();
      unsubscribeV1();
      unsubscribeBookmarks();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [activeBookId, deviceId, ownerKey, progressRef, setRemoteProgress, user]);
};
