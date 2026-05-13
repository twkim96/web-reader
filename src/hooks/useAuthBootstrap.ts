import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { collection, onSnapshot } from 'firebase/firestore';
import { APP_ID, auth, db } from '../lib/firebase';
import { saveProgressToLocal } from '../lib/localDB';
import { Bookmark, UserProgress, ViewState } from '../types';
import { getTimestampMs, RemoteProgressDoc } from './useLibraryData';

interface UseAuthBootstrapOptions {
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  isGuestRef: MutableRefObject<boolean>;
  getStoredToken: () => string | null;
  setGoogleToken: (token: string | null) => void;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (preventRedirect?: boolean) => Promise<boolean>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
  syncLocalAndCloud: (uid: string) => Promise<void>;
}

export const useAuthBootstrap = ({
  deviceId,
  progressRef,
  isGuestRef,
  getStoredToken,
  setGoogleToken,
  setUser,
  setIsGuest,
  setIsOfflineMode,
  setProgress,
  setRemoteProgress,
  setView,
  restoreLocalData,
  loadLibraryFromDrive,
  syncLocalAndCloud,
}: UseAuthBootstrapOptions) => {
  useEffect(() => {
    let isActive = true;
    let unsubscribeProgress: (() => void) | undefined;
    let authRedirectTimeout: number | undefined;

    const clearProgressSubscription = () => {
      unsubscribeProgress?.();
      unsubscribeProgress = undefined;
    };

    const subscribeReadingHistory = (uid: string) => {
      const historyRef = collection(db, 'artifacts', APP_ID, 'users', uid, 'readingHistory');
      return onSnapshot(historyRef, async (snapshot) => {
        const isFromCache = snapshot.metadata.fromCache;
        const hasPending = snapshot.metadata.hasPendingWrites;
        const nextProgress: Record<string, UserProgress> = {};

        for (const documentSnapshot of snapshot.docs) {
          const raw = documentSnapshot.data() as RemoteProgressDoc;
          const serverTime = getTimestampMs(raw.lastRead);
          const serverBookmarks = raw.bookmarks || [];
          const currentLocal = progressRef.current[raw.bookId || documentSnapshot.id]?.bookmarks || [];
          const localAuto = currentLocal.filter((bookmark: Bookmark) => bookmark.type === 'auto');
          const mergedBookmarks = [
            ...serverBookmarks.filter((bookmark: Bookmark) => bookmark.type === 'manual'),
            ...localAuto,
          ].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

          const bookId = raw.bookId || documentSnapshot.id;
          const data: UserProgress = {
            bookId,
            cfi: raw.cfi || '',
            progressPercent: raw.progressPercent || 0,
            lastRead: serverTime,
            bookmarks: mergedBookmarks,
          };
          nextProgress[bookId] = data;

          if (!isFromCache && !hasPending) {
            await saveProgressToLocal({ ...data, lastRead: serverTime });
          }
        }

        setProgress((prev) => {
          const hasChanged = Object.keys(nextProgress).some((id) => {
            const old = prev[id];
            if (!old) return true;
            return old.cfi !== nextProgress[id].cfi ||
              old.progressPercent !== nextProgress[id].progressPercent ||
              (old.bookmarks?.length || 0) !== (nextProgress[id].bookmarks?.length || 0);
          }) || Object.keys(prev).length !== Object.keys(nextProgress).length;

          return hasChanged ? { ...prev, ...nextProgress } : prev;
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
                  progressPercent: data.progressPercent || 0,
                  lastRead: serverTime,
                  bookmarks: data.bookmarks || [],
                };

                if (!prev[documentSnapshot.id] ||
                  prev[documentSnapshot.id].cfi !== data.cfi ||
                  prev[documentSnapshot.id].progressPercent !== data.progressPercent) {
                  updated[documentSnapshot.id] = entry;
                  changed = true;
                }
              }
            }

            return changed ? updated : prev;
          });
        }
      });
    };

    queueMicrotask(() => {
      if (isActive) {
        restoreLocalData();
      }
    });

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      clearProgressSubscription();

      if (authRedirectTimeout) {
        window.clearTimeout(authRedirectTimeout);
        authRedirectTimeout = undefined;
      }

      if (firebaseUser) {
        setIsGuest(false);
        isGuestRef.current = false;
        unsubscribeProgress = subscribeReadingHistory(firebaseUser.uid);

        void (async () => {
          await restoreLocalData(true);
          if (!isActive) return;

          const recoveredToken = getStoredToken();
          if (recoveredToken) {
            setGoogleToken(recoveredToken);
            setIsOfflineMode(false);
            setView((prev) => (prev === 'shelf' || prev === 'reader') ? prev : 'loading');

            const isSuccess = await loadLibraryFromDrive(recoveredToken);
            if (!isActive) return;

            if (isSuccess) {
              syncLocalAndCloud(firebaseUser.uid);
              setIsOfflineMode(false);
            } else {
              setIsOfflineMode(true);
            }
            setView((prev) => prev === 'reader' ? 'reader' : 'shelf');
          } else {
            setIsOfflineMode(true);
            setView((prev) => prev === 'reader' ? 'reader' : 'shelf');
          }
        })();
      } else if (!isGuestRef.current) {
        authRedirectTimeout = window.setTimeout(() => {
          setView((prev) => {
            if (prev === 'shelf') return prev;
            return 'auth';
          });
        }, 500);
      }
    });

    return () => {
      isActive = false;
      if (authRedirectTimeout) {
        window.clearTimeout(authRedirectTimeout);
      }
      clearProgressSubscription();
      unsubscribeAuth();
    };
  }, [
    deviceId,
    getStoredToken,
    isGuestRef,
    loadLibraryFromDrive,
    progressRef,
    restoreLocalData,
    setGoogleToken,
    setIsGuest,
    setIsOfflineMode,
    setProgress,
    setRemoteProgress,
    setUser,
    setView,
    syncLocalAndCloud,
  ]);
};
