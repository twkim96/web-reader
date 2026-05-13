import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react';
import { getRedirectResult, onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ViewState } from '../types';
import type { RestoreLocalDataOptions } from './useLibraryData';

const GOOGLE_AUTH_REDIRECT_PENDING_KEY = 'google_auth_redirect_pending';

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
    let redirectSettled = sessionStorage.getItem(GOOGLE_AUTH_REDIRECT_PENDING_KEY) !== 'true';

    if (!redirectSettled) {
      setView('loading');
      setIsGuest(false);
      isGuestRef.current = false;
      localStorage.removeItem('isGuest');

      void getRedirectResult(auth)
        .catch((error) => {
          console.error('[Auth] Failed to resolve Google redirect:', error);
        })
        .finally(() => {
          redirectSettled = true;
          sessionStorage.removeItem(GOOGLE_AUTH_REDIRECT_PENDING_KEY);
          if (isActive && !auth.currentUser) {
            setView('auth');
          }
        });
    } else {
      queueMicrotask(() => {
        if (!isActive) return;
        restoreLocalData();
      });
    }

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      if (!firebaseUser && !redirectSettled) return;

      setUser(firebaseUser);

      if (authRedirectTimeout) {
        window.clearTimeout(authRedirectTimeout);
        authRedirectTimeout = undefined;
      }

      if (firebaseUser) {
        sessionStorage.removeItem(GOOGLE_AUTH_REDIRECT_PENDING_KEY);
        redirectSettled = true;
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
