import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { saveProgressToLocal } from '../lib/localDB';
import { UserProgress } from '../types';
import {
  getTimestampMs,
  hasRemoteProgressChanged,
  mergeRemoteManualWithLocalAuto,
  RemoteProgressDoc,
  toProgressPercent,
} from './progressPolicy';

interface UseProgressSyncOptions {
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
}

export const useProgressSync = ({
  user,
  deviceId,
  progressRef,
  setProgress,
  setRemoteProgress,
}: UseProgressSyncOptions) => {
  useEffect(() => {
    if (!user) return;

    const historyRef = collection(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory');
    return onSnapshot(historyRef, async (snapshot) => {
      const isFromCache = snapshot.metadata.fromCache;
      const hasPending = snapshot.metadata.hasPendingWrites;
      const nextProgress: Record<string, UserProgress> = {};

      for (const documentSnapshot of snapshot.docs) {
        const raw = documentSnapshot.data() as RemoteProgressDoc;
        const bookId = raw.bookId || documentSnapshot.id;
        const serverTime = getTimestampMs(raw.lastRead);
        const currentLocal = progressRef.current[bookId]?.bookmarks || [];
        const mergedBookmarks = mergeRemoteManualWithLocalAuto(raw.bookmarks || [], currentLocal);
        const progressPercent = toProgressPercent(raw.progressPercent) ?? 0;

        const data: UserProgress = {
          bookId,
          cfi: raw.cfi || '',
          anchorCfi: raw.anchorCfi || raw.cfi || '',
          progressPercent,
          lastRead: serverTime,
          bookmarks: mergedBookmarks,
        };
        nextProgress[bookId] = data;

        if (!isFromCache && !hasPending) {
          await saveProgressToLocal({ ...data, lastRead: serverTime });
        }
      }

      setProgress((prev) => {
        const hasChanged = Object.keys(nextProgress).some((id) => (
          hasRemoteProgressChanged(prev[id], nextProgress[id])
        )) || Object.keys(prev).length !== Object.keys(nextProgress).length;

        if (!hasChanged) return prev;

        const merged = { ...prev, ...nextProgress };
        progressRef.current = merged;
        return merged;
      });

      if (!isFromCache) {
        setRemoteProgress((prev) => {
          let changed = false;
          const updated = { ...prev };

          for (const documentSnapshot of snapshot.docs) {
            const data = documentSnapshot.data() as RemoteProgressDoc;
            if (data.deviceId && data.deviceId !== deviceId.current) {
              const serverTime = getTimestampMs(data.lastRead);
              const entry: UserProgress = {
                bookId: data.bookId || documentSnapshot.id,
                cfi: data.cfi || '',
                anchorCfi: data.anchorCfi || data.cfi || '',
                progressPercent: toProgressPercent(data.progressPercent) ?? 0,
                lastRead: serverTime,
                bookmarks: data.bookmarks || [],
              };

              if (hasRemoteProgressChanged(prev[documentSnapshot.id], entry)) {
                updated[documentSnapshot.id] = entry;
                changed = true;
              }
            }
          }

          return changed ? updated : prev;
        });
      }
    });
  }, [deviceId, progressRef, setProgress, setRemoteProgress, user]);
};
