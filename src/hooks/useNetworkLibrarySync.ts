import { Dispatch, SetStateAction, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { ViewState } from '../types';

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

  useEffect(() => {
    if (
      !user
      || !isAuthenticatedLibraryReady
      || !googleToken
      || !driveSessionId
      || loadedDriveSessionRef.current === driveSessionId
    ) return;
    loadedDriveSessionRef.current = driveSessionId;
    let active = true;
    window.queueMicrotask(() => {
      if (!active) return;
      setView('loading');
      void loadLibraryFromDrive(googleToken, driveSessionId).then((isSuccess) => {
        if (!active) return;
        if (!isSuccess) setIsOfflineMode(true);
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
    user,
  ]);

  useEffect(() => {
    const handleOnline = () => {
      if (!user || !googleToken) return;

      loadLibraryFromDrive(googleToken).then((isSuccess) => {
        if (!isSuccess) setIsOfflineMode(true);
      });
    };

    const handleOffline = () => {
      setIsOfflineMode(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [googleToken, loadLibraryFromDrive, setIsOfflineMode, user]);
};
