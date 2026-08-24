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
    let initialAuthSettled = false;
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

    const enterGuestLibrary = (generation: number) => {
      setIsGuest(true);
      isGuestRef.current = true;
      localStorage.setItem('isGuest', 'true');
      activateGuest(generation);
    };

    // A remembered guest is entirely local. Do not hold its shelf behind an
    // external Firebase callback; that callback may arrive late or not at all.
    if (isGuestRef.current) activateGuest(++authGeneration);

    const authFallbackTimer = window.setTimeout(() => {
      if (!isActive || initialAuthSettled || isGuestRef.current || auth.currentUser) return;
      enterGuestLibrary(++authGeneration);
    }, 3_000);

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      initialAuthSettled = true;
      window.clearTimeout(authFallbackTimer);
      setIsAuthenticatedLibraryReady(false);
      setIsLibraryBootstrapReady(false);
      const callbackGeneration = ++authGeneration;
      const previousOwner = ownerRuntime.capture();
      if (firebaseUser) {
        // A later logout must hydrate the guest owner again instead of reusing
        // the guest restore that may have completed before the login redirect.
        guestRestore = null;
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
        setIsGuest(true);
        activateGuest(callbackGeneration);
      } else {
        enterGuestLibrary(callbackGeneration);
      }
      setUser(firebaseUser);

      if (firebaseUser) {
        setIsGuest(false);
        isGuestRef.current = false;
        localStorage.removeItem('isGuest');
      }
    });

    return () => {
      isActive = false;
      window.clearTimeout(authFallbackTimer);
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
