import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ViewState } from '../types';
import type { RestoreLocalDataOptions } from './useLibraryData';

interface UseAuthBootstrapOptions {
  isGuestRef: MutableRefObject<boolean>;
  getStoredToken: () => string | null;
  setGoogleToken: (token: string | null) => void;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<boolean>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
  syncLocalAndCloud: (uid: string) => Promise<void>;
}

export const useAuthBootstrap = ({
  isGuestRef,
  getStoredToken,
  setGoogleToken,
  setUser,
  setIsGuest,
  setIsOfflineMode,
  setView,
  restoreLocalData,
  loadLibraryFromDrive,
  syncLocalAndCloud,
}: UseAuthBootstrapOptions) => {
  useEffect(() => {
    let isActive = true;
    let authRedirectTimeout: number | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);

      if (authRedirectTimeout) {
        window.clearTimeout(authRedirectTimeout);
        authRedirectTimeout = undefined;
      }

      if (firebaseUser) {
        setIsGuest(false);
        isGuestRef.current = false;
        localStorage.removeItem('isGuest');

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
      } else if (isGuestRef.current) {
        void (async () => {
          await restoreLocalData({ replaceBooks: true });
          if (!isActive) return;

          setIsOfflineMode(true);
          setView('shelf');
        })();
      } else {
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
      unsubscribeAuth();
    };
  }, [
    getStoredToken,
    isGuestRef,
    loadLibraryFromDrive,
    restoreLocalData,
    setGoogleToken,
    setIsGuest,
    setIsOfflineMode,
    setUser,
    setView,
    syncLocalAndCloud,
  ]);
};
