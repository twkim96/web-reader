import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef, useState } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ViewState } from '../types';
import type { RestoreLocalDataOptions, RestoreLocalDataResult } from './useLibraryData';
import {
  getOrCreateGuestInstallId,
  isGuestOwner,
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
  type OwnerKey,
} from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useOwnerSnapshot } from './useOwnerSnapshot';

interface UseAuthBootstrapOptions {
  isGuestRef: MutableRefObject<boolean>;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<RestoreLocalDataResult>;
  resetLibraryState: () => void;
  shouldHoldShelfForDrive: () => boolean;
  logoutReadingOwner?: MutableRefObject<OwnerKey | undefined>;
  onAuthenticatedLibraryRestoreSettled?: () => void;
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
  logoutReadingOwner,
  onAuthenticatedLibraryRestoreSettled,
}: UseAuthBootstrapOptions) => {
  const activeOwner = useOwnerSnapshot();
  const [readyOwnerKey, setReadyOwnerKey] = useState<OwnerKey | null>(null);
  const isLibraryBootstrapReady = readyOwnerKey !== null && readyOwnerKey === activeOwner?.ownerKey;
  const isAuthenticatedLibraryReady = isLibraryBootstrapReady && !isGuestOwner(readyOwnerKey);
  const [libraryRestoreFailed, setLibraryRestoreFailed] = useState(false);
  const retryRestore = useRef<(() => void) | null>(null);
  const retryLibraryRestore = useCallback(() => retryRestore.current?.(), []);

  useEffect(() => {
    let isActive = true;
    let initialAuthSettled = false;
    let authGeneration = 0;
    let guestRestore: Promise<RestoreLocalDataResult> | null = null;
    setReadyOwnerKey(null);

    const restoreLibrary = (
      generation: number,
      restore: () => Promise<RestoreLocalDataResult>,
      onReady: () => void,
      onFailure?: () => void,
    ) => {
      const isCurrent = () => isActive && generation === authGeneration;
      const start = () => {
        if (!isCurrent()) return;
        retryRestore.current = null;
        setLibraryRestoreFailed(false);
        void (async () => {
          const result = await restore().catch((error: unknown) => {
            console.error('[AuthBootstrap] library restore failed:', error);
            return 'failed' as const;
          });
          if (!isCurrent() || result === 'stale') return;
          if (result === 'failed') {
            retryRestore.current = start;
            setLibraryRestoreFailed(true);
            onFailure?.();
            return;
          }
          onReady();
        })();
      };
      start();
    };

    const activateGuest = (generation: number) => {
      const previousOwner = ownerRuntime.capture();
      const nextOwner = ownerRuntime.activate(makeOwnerKey(
        makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)),
        'library:local',
      ));
      if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();
      const restoreGuest = () => {
        if (guestRestore) return guestRestore;
        const retainPositionsFrom = logoutReadingOwner?.current;
        if (logoutReadingOwner) logoutReadingOwner.current = undefined;
        guestRestore = restoreLocalData({ replaceBooks: true, retainPositionsFrom });
        return guestRestore;
      };
      restoreLibrary(generation, restoreGuest, () => {
        setReadyOwnerKey(nextOwner.ownerKey);
        setIsOfflineMode(true);
        setView((current) => current === 'reader' ? 'reader' : 'shelf');
      }, () => {
        guestRestore = null;
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
      // An offline Firebase restore can outlast this UI fallback. Wait for the
      // SDK to resolve the cached account before exposing the guest reader.
      if (navigator.onLine === false) return;
      enterGuestLibrary(++authGeneration);
    }, 3_000);

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      initialAuthSettled = true;
      window.clearTimeout(authFallbackTimer);
      setReadyOwnerKey(null);
      const callbackGeneration = ++authGeneration;
      const previousOwner = ownerRuntime.capture();
      if (firebaseUser) {
        // A later logout must hydrate the guest owner again instead of reusing
        // the guest restore that may have completed before the login redirect.
        guestRestore = null;
        const authOwnerKey = makeFirebaseOwnerKey(firebaseUser.uid);
        const nextOwner = ownerRuntime.activate(makeOwnerKey(authOwnerKey, 'library:local'));
        if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();

        restoreLibrary(callbackGeneration, () => restoreLocalData({ preventRedirect: true, replaceBooks: true }), () => {
          setReadyOwnerKey(nextOwner.ownerKey);
          onAuthenticatedLibraryRestoreSettled?.();
          if (navigator.onLine !== false && shouldHoldShelfForDrive()) {
            setView('loading');
            return;
          }
          setIsOfflineMode(true);
          setView((prev) => prev === 'reader' ? 'reader' : 'shelf');
        }, onAuthenticatedLibraryRestoreSettled);
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
      retryRestore.current = null;
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
    logoutReadingOwner,
    onAuthenticatedLibraryRestoreSettled,
  ]);

  return { isAuthenticatedLibraryReady, isLibraryBootstrapReady, libraryRestoreFailed, retryLibraryRestore };
};
