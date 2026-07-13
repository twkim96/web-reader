import { Dispatch, MutableRefObject, SetStateAction, useEffect } from 'react';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { ViewState } from '../types';
import type { RestoreLocalDataOptions } from './useLibraryData';
import {
  getOrCreateGuestInstallId,
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
  splitOwnerKey,
} from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import { getOwnerSessionV5 } from '../lib/localDBV5';

interface UseAuthBootstrapOptions {
  isGuestRef: MutableRefObject<boolean>;
  setUser: Dispatch<SetStateAction<FirebaseUser | null>>;
  setIsGuest: Dispatch<SetStateAction<boolean>>;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  restoreLocalData: (options?: boolean | RestoreLocalDataOptions) => Promise<boolean>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
  resetLibraryState: () => void;
}

export const useAuthBootstrap = ({
  isGuestRef,
  setUser,
  setIsGuest,
  setIsOfflineMode,
  setView,
  restoreLocalData,
  loadLibraryFromDrive,
  resetLibraryState,
}: UseAuthBootstrapOptions) => {
  useEffect(() => {
    let isActive = true;
    let authRedirectTimeout: number | undefined;
    let authGeneration = 0;

    const unsubscribeAuth = onAuthStateChanged(auth, (firebaseUser) => {
      const callbackGeneration = ++authGeneration;
      const previousOwner = ownerRuntime.capture();
      if (firebaseUser) {
        const authOwnerKey = makeFirebaseOwnerKey(firebaseUser.uid);
        const nextOwner = ownerRuntime.activate(makeOwnerKey(authOwnerKey, 'library:local'));
        if (previousOwner?.ownerKey !== nextOwner.ownerKey) resetLibraryState();

        void (async () => {
          const lastSession = await getOwnerSessionV5(authOwnerKey).catch(() => undefined);
          if (!isActive || callbackGeneration !== authGeneration) return;
          if (lastSession?.authOwnerKey === authOwnerKey) {
            try {
              const sessionIdentity = splitOwnerKey(lastSession.ownerKey);
              if (sessionIdentity.authOwnerKey === authOwnerKey) {
                const sessionOwner = ownerRuntime.activate(lastSession.ownerKey);
                if (sessionOwner.ownerKey !== nextOwner.ownerKey) resetLibraryState();
              }
            } catch {
              // Ignore malformed persisted identity and keep the local namespace.
            }
          }
          await restoreLocalData({ preventRedirect: true, replaceBooks: true });
          if (!isActive || callbackGeneration !== authGeneration) return;
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
    loadLibraryFromDrive,
    restoreLocalData,
    resetLibraryState,
    setIsGuest,
    setIsOfflineMode,
    setUser,
    setView,
  ]);
};
