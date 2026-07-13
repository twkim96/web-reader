import { Dispatch, MutableRefObject, SetStateAction, useEffect, useState } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ViewState } from '../types';
import type { RestoreLocalDataOptions } from './useLibraryData';
import {
  getOrCreateGuestInstallId,
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
} from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';

interface UseAuthBootstrapOptions {
  isGuestRef: MutableRefObject<boolean>;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<boolean>;
  resetLibraryState: () => void;
  shouldHoldShelfForDrive: () => boolean;
}

export const useAuthBootstrap = ({
  isGuestRef,
  setUser,
  setIsGuest,
  setIsOfflineMode,
  setView,
  restoreLocalData,
  resetLibraryState,
  shouldHoldShelfForDrive,
}: UseAuthBootstrapOptions) => {
  const [isAuthenticatedLibraryReady, setIsAuthenticatedLibraryReady] = useState(false);

  useEffect(() => {
    let isActive = true;
    let authRedirectTimeout: number | undefined;
    let authGeneration = 0;

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setIsAuthenticatedLibraryReady(false);
      const callbackGeneration = ++authGeneration;
      const previousOwner = ownerRuntime.capture();
      if (firebaseUser) {
        const authOwnerKey = makeFirebaseOwnerKey(firebaseUser.uid);
        const nextOwner = ownerRuntime.activate(makeOwnerKey(authOwnerKey, 'library:local'));
        if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();

        void (async () => {
          await restoreLocalData({ preventRedirect: true, replaceBooks: true });
          if (!isActive || callbackGeneration !== authGeneration) return;
          setIsAuthenticatedLibraryReady(true);
          if (shouldHoldShelfForDrive()) {
            setView('loading');
            return;
          }
          setIsOfflineMode(true);
          setView((prev) => prev === 'reader' ? 'reader' : 'shelf');
        })();
      } else if (isGuestRef.current) {
        const nextOwner = ownerRuntime.activate(makeOwnerKey(
          makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)),
          'library:local',
        ));
        if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();
      } else {
        ownerRuntime.clear();
        resetLibraryState();
      }
      setUser(firebaseUser);

      if (authRedirectTimeout) {
        window.clearTimeout(authRedirectTimeout);
        authRedirectTimeout = undefined;
      }

      if (firebaseUser) {
        setIsGuest(false);
        isGuestRef.current = false;
        localStorage.removeItem('isGuest');

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
    isGuestRef,
    restoreLocalData,
    resetLibraryState,
    setIsGuest,
    setIsOfflineMode,
    setUser,
    setView,
    shouldHoldShelfForDrive,
  ]);

  return isAuthenticatedLibraryReady;
};
