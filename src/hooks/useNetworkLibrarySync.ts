import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { ViewState } from '../types';
import { ownerRuntime } from '../lib/ownerRuntime';

interface UseNetworkLibrarySyncOptions {
  user: FirebaseUser | null;
  googleToken: string | null;
  driveSessionId: string | null;
  isAuthenticatedLibraryReady: boolean;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
}

export const useNetworkLibrarySync = ({
  user,
  googleToken,
  driveSessionId,
  isAuthenticatedLibraryReady,
  setIsOfflineMode,
  setView,
  loadLibraryFromDrive,
}: UseNetworkLibrarySyncOptions) => {
  const loadedDriveSessionRef = useRef<string | null>(null);
  const userId = user?.uid;
  const ownerGeneration = ownerRuntime.capture()?.generation;

  useEffect(() => {
    if (!userId || !isAuthenticatedLibraryReady || !googleToken || !driveSessionId) {
      loadedDriveSessionRef.current = null;
      return;
    }
    const loadIdentity = JSON.stringify([userId, ownerGeneration, driveSessionId]);
    if (loadedDriveSessionRef.current === loadIdentity) return;
    loadedDriveSessionRef.current = null;
    let active = true;
    window.queueMicrotask(() => {
      if (!active) return;
      setView('loading');
      void loadLibraryFromDrive(googleToken, driveSessionId).then((isSuccess) => {
        if (!active) return;
        if (isSuccess) loadedDriveSessionRef.current = loadIdentity;
        else setIsOfflineMode(true);
        setView('shelf');
      }).catch(() => {
        if (!active) return;
        setIsOfflineMode(true);
        setView('shelf');
      });
    });
    return () => {
      active = false;
    };
  }, [
    driveSessionId,
    googleToken,
    isAuthenticatedLibraryReady,
    loadLibraryFromDrive,
    setIsOfflineMode,
    setView,
    userId,
    ownerGeneration,
  ]);

  useEffect(() => {
    let active = true;
    const handleOnline = () => {
      if (!userId || !isAuthenticatedLibraryReady || !googleToken || !driveSessionId) return;

      void loadLibraryFromDrive(googleToken, driveSessionId).then((isSuccess) => {
        if (active && !isSuccess) setIsOfflineMode(true);
      }).catch(() => {
        if (active) setIsOfflineMode(true);
      });
    };

    const handleOffline = () => {
      setIsOfflineMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [driveSessionId, googleToken, isAuthenticatedLibraryReady, loadLibraryFromDrive, setIsOfflineMode, userId, ownerGeneration]);
};
