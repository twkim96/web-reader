import { Dispatch, MutableRefObject, SetStateAction, useCallback } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { doc, serverTimestamp, setDoc } from 'firebase/firestore';
import { APP_ID, db } from '../lib/firebase';
import { saveProgressToLocal } from '../lib/localDB';
import { Book, Bookmark, SaveProgressOptions, UserProgress } from '../types';
import { getManualBookmarks, hasProgressChanged, toProgressPercent } from './progressPolicy';

interface UseProgressActionsOptions {
  activeBook: Book | null;
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
}

export const useProgressActions = ({
  activeBook,
  user,
  deviceId,
  progressRef,
  setProgress,
}: UseProgressActionsOptions) => {
  const persistProgress = useCallback(async (bookId: string, progressData: UserProgress) => {
    try {
      await saveProgressToLocal(progressData);
    } catch (error) {
      console.error('[SaveProgress] local save failed:', error);
    }

    if (!user) return;

    try {
      const remoteData = {
        ...progressData,
        bookmarks: getManualBookmarks(progressData.bookmarks),
        lastRead: serverTimestamp(),
        deviceId: deviceId.current,
      };
      const docRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', bookId);
      await setDoc(docRef, remoteData, { merge: true });
    } catch (error) {
      console.error('[SaveProgress] Firestore save failed:', error);
    }
  }, [deviceId, user]);

  const saveProgress = useCallback((cfi: number | string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => {
    if (!activeBook) return;

    const bookId = activeBook.id;
    const nextCfi = String(cfi || '');
    if (!nextCfi) return;

    const existing = progressRef.current[bookId];
    const existingPercent = toProgressPercent(existing?.progressPercent);
    const safePercent = toProgressPercent(pct) ?? existingPercent ?? 0;
    const existingBookmarks = existing?.bookmarks || [];
    const finalBookmarks = bookmarks !== undefined ? bookmarks : existingBookmarks;

    if (!options?.force && !hasProgressChanged(existing, nextCfi, safePercent, finalBookmarks)) {
      return;
    }

    const progressData: UserProgress = {
      bookId,
      cfi: nextCfi,
      progressPercent: safePercent,
      lastRead: Date.now(),
      bookmarks: finalBookmarks,
    };

    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));
    void persistProgress(bookId, progressData);
  }, [activeBook, persistProgress, progressRef, setProgress]);

  const deleteProgress = useCallback(async (bookId: string) => {
    const resetData: UserProgress = {
      bookId,
      cfi: '',
      progressPercent: 0,
      lastRead: Date.now(),
      bookmarks: [],
    };

    setProgress((prev) => ({ ...prev, [bookId]: resetData }));
    progressRef.current = { ...progressRef.current, [bookId]: resetData };

    try {
      await saveProgressToLocal(resetData);
    } catch (error) {
      console.error('[DeleteProgress] local save failed:', error);
    }

    if (!user) return;

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'readingHistory', bookId), {
        ...resetData,
        lastRead: serverTimestamp(),
        deviceId: deviceId.current,
      }, { merge: true });
    } catch (error) {
      console.error('[DeleteProgress] Firestore save failed:', error);
    }
  }, [deviceId, progressRef, setProgress, user]);

  return {
    saveProgress,
    deleteProgress,
  };
};
