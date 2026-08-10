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
  const [isLibraryBootstrapReady, setIsLibraryBootstrapReady] = useState(false);

  useEffect(() => {
    let isActive = true;
    let authRedirectTimeout: number | undefined;
    let authGeneration = 0;
    let guestRestore: Promise<boolean> | null = null;
    setIsLibraryBootstrapReady(false);

    const activateGuest = (generation: number) => {
      const previousOwner = ownerRuntime.capture();
      const nextOwner = ownerRuntime.activate(makeOwnerKey(
        makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)),
        'library:local',
      ));
      if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();
      guestRestore ??= restoreLocalData({ replaceBooks: true });
      void guestRestore.then(() => {
        if (!isActive || generation !== authGeneration || !isGuestRef.current) return;
        setIsLibraryBootstrapReady(true);
        setIsOfflineMode(true);
        setView((current) => current === 'reader' ? 'reader' : 'shelf');
      }).catch((error) => {
        if (!isActive || generation !== authGeneration) return;
        console.error('[AuthBootstrap] guest restore failed:', error);
      });
    };

    // A remembered guest is entirely local. Do not hold its shelf behind an
    // external Firebase callback; that callback may arrive late or not at all.
    if (isGuestRef.current) activateGuest(++authGeneration);

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      setIsAuthenticatedLibraryReady(false);
      setIsLibraryBootstrapReady(false);
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
          setIsLibraryBootstrapReady(true);
          if (shouldHoldShelfForDrive()) {
            setView('loading');
            return;
          }
          setIsOfflineMode(true);
          setView((prev) => prev === 'reader' ? 'reader' : 'shelf');
        })();
      } else if (isGuestRef.current) {
        activateGuest(callbackGeneration);
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
        // The eager local restore above is shared with this callback. Its
        // generation check prevents a late guest continuation from winning
        // after an authenticated owner has taken over.
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

  return { isAuthenticatedLibraryReady, isLibraryBootstrapReady };
};
