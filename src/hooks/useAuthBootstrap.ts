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
import { libraryLandingView } from '../lib/loginNavigation';

interface UseAuthBootstrapOptions {
  isGuestRef: MutableRefObject<boolean>;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<RestoreLocalDataResult>;
  resetLibraryState: () => void;
  shouldHoldShelfForDrive: () => boolean;
  shouldWaitForAuthRedirect?: () => boolean;
  flushOutgoingProgress?: () => Promise<boolean> | undefined;
  onLibraryRestoreSettled?: (authenticated: boolean) => void;
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
  shouldWaitForAuthRedirect,
  flushOutgoingProgress,
  onLibraryRestoreSettled,
}: UseAuthBootstrapOptions) => {
  const activeOwner = useOwnerSnapshot();
  const [readyOwnerKey, setReadyOwnerKey] = useState<OwnerKey | null>(null);
  const isLibraryBootstrapReady = readyOwnerKey !== null && readyOwnerKey === activeOwner?.ownerKey;
  const isAuthenticatedLibraryReady = isLibraryBootstrapReady && !isGuestOwner(readyOwnerKey);
  const [libraryRestoreFailed, setLibraryRestoreFailed] = useState(false);
  const [flushingOutgoingProgress, setFlushingOutgoingProgress] = useState(false);
  const [outgoingProgressFailed, setOutgoingProgressFailed] = useState(false);
  const retryOutgoingProgressRef = useRef<(() => void) | null>(null);
  const retryOutgoingProgress = useCallback(() => retryOutgoingProgressRef.current?.(), []);
  const retryRestore = useRef<(() => void) | null>(null);
  const retryLibraryRestore = useCallback(() => retryRestore.current?.(), []);

  useEffect(() => {
    let isActive = true;
    let initialAuthSettled = false;
    let authGeneration = 0;
    let guestRestore: Promise<RestoreLocalDataResult> | null = null;
    const returningFromAuth = shouldWaitForAuthRedirect?.() ?? false;
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

    const guestOwnerKey = () => makeOwnerKey(
      makeGuestOwnerKey(getOrCreateGuestInstallId(localStorage)), 'library:local',
    );
    const activateGuest = (generation: number, confirmed = false, refreshFrom?: OwnerKey) => {
      const previousOwner = ownerRuntime.capture();
      const nextOwner = ownerRuntime.activate(guestOwnerKey());
      if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();
      const restoreGuest = () => restoreLocalData({
        preventRedirect: true, replaceBooks: true, guestHandoff: { owner: nextOwner.ownerKey, confirmed, ...(refreshFrom && { refreshFrom }) },
      });
      if (confirmed && guestRestore) {
        guestRestore = guestRestore.then(result => result === 'stale' && ownerRuntime.isCurrent(nextOwner)
          ? restoreGuest()
          : result);
      }
      restoreLibrary(generation, () => guestRestore ??= restoreGuest(), () => {
        setReadyOwnerKey(nextOwner.ownerKey);
        setIsOfflineMode(true);
        setView((current) => current === 'reader' ? current : libraryLandingView());
        if (confirmed) onLibraryRestoreSettled?.(false);
      }, () => {
        guestRestore = null;
        if (confirmed) onLibraryRestoreSettled?.(false);
      });
    };

    const enterGuestLibrary = (generation: number, confirmed = false, refreshFrom?: OwnerKey) => {
      setIsGuest(true);
      isGuestRef.current = true;
      localStorage.setItem('isGuest', 'true');
      activateGuest(generation, confirmed, refreshFrom);
    };

    // A remembered guest is entirely local. Do not hold its shelf behind an
    // external Firebase callback; that callback may arrive late or not at all.
    if (isGuestRef.current && !returningFromAuth) activateGuest(++authGeneration);

    const authFallbackTimer = window.setTimeout(() => {
      if (!isActive || initialAuthSettled || isGuestRef.current || auth.currentUser) return;
      if (returningFromAuth) return;
      // An offline Firebase restore can outlast this UI fallback. Wait for the
      // SDK to resolve the cached account before exposing the guest reader.
      if (navigator.onLine === false) return;
      enterGuestLibrary(++authGeneration);
    }, 3_000);

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      initialAuthSettled = true;
      window.clearTimeout(authFallbackTimer);
      const callbackGeneration = ++authGeneration;
      const previousOwner = ownerRuntime.capture();
      const nextOwnerKey = firebaseUser
        ? makeOwnerKey(makeFirebaseOwnerKey(firebaseUser.uid), 'library:local')
        : guestOwnerKey();

      const applyAuthChange = () => {
        if (!isActive || callbackGeneration !== authGeneration) return;
        retryOutgoingProgressRef.current = null;
        setFlushingOutgoingProgress(false);
        setOutgoingProgressFailed(false);
        setReadyOwnerKey(null);
        if (!firebaseUser) {
          enterGuestLibrary(callbackGeneration, true,
            previousOwner && !isGuestOwner(previousOwner.ownerKey) ? previousOwner.ownerKey : undefined);
          setUser(null);
          return;
        }
        // A later logout must hydrate the guest owner again instead of reusing
        // the guest restore that may have completed before the login redirect.
        guestRestore = null;
        const nextOwner = ownerRuntime.activate(nextOwnerKey);
        if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();

        restoreLibrary(callbackGeneration, () => restoreLocalData({
          preventRedirect: true, replaceBooks: true, guestHandoff: { owner: guestOwnerKey(), confirmed: true },
        }), () => {
          setReadyOwnerKey(nextOwner.ownerKey);
          onLibraryRestoreSettled?.(true);
          if (navigator.onLine !== false && shouldHoldShelfForDrive()) {
            setView('loading');
            return;
          }
          setIsOfflineMode(true);
          setView((current) => current === 'reader' ? current : libraryLandingView());
        }, () => onLibraryRestoreSettled?.(true));
        setUser(firebaseUser);
        setIsGuest(false);
        isGuestRef.current = false;
        localStorage.removeItem('isGuest');
      };

      // Flush against the outgoing owner before the account boundary invalidates
      // its reader. The callback may have been triggered by a different tab.
      const flushThenSwitch = () => {
        if (!isActive || callbackGeneration !== authGeneration) return;
        retryOutgoingProgressRef.current = null;
        setOutgoingProgressFailed(false);
        const flush = previousOwner && previousOwner.ownerKey !== nextOwnerKey
          ? flushOutgoingProgress?.() : undefined;
        if (!flush) {
          applyAuthChange();
          return;
        }
        setFlushingOutgoingProgress(true);
        const preserveForRetry = () => {
          if (!isActive || callbackGeneration !== authGeneration) return;
          retryOutgoingProgressRef.current = flushThenSwitch;
          setOutgoingProgressFailed(true);
        };
        void flush.then((saved) => {
          if (saved) applyAuthChange();
          else preserveForRetry();
        }, (error) => {
          console.error('[AuthBootstrap] outgoing position flush failed:', error);
          preserveForRetry();
        });
      };
      flushThenSwitch();
    });

    return () => {
      isActive = false;
      retryRestore.current = null;
      retryOutgoingProgressRef.current = null;
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
    shouldWaitForAuthRedirect,
    flushOutgoingProgress,
    onLibraryRestoreSettled,
  ]);

  return {
    isAuthenticatedLibraryReady, isLibraryBootstrapReady, libraryRestoreFailed, retryLibraryRestore,
    flushingOutgoingProgress, outgoingProgressFailed, retryOutgoingProgress,
  };
};
