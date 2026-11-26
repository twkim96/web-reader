import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { ownerRuntime } from '../lib/ownerRuntime';

interface UseNetworkLibrarySyncOptions {
  user: FirebaseUser | null;
  googleToken: string | null;
  driveSessionId: string | null;
  getCurrentDriveSessionId: () => string | null;
  isAuthenticatedLibraryReady: boolean;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
}

export const useNetworkLibrarySync = ({
  user,
  googleToken,
  driveSessionId,
  getCurrentDriveSessionId,
  isAuthenticatedLibraryReady,
  setIsOfflineMode,
  loadLibraryFromDrive,
}: UseNetworkLibrarySyncOptions) => {
  const owner = ownerRuntime.capture();
  const identity = user && isAuthenticatedLibraryReady && googleToken && driveSessionId
    ? JSON.stringify([user.uid, owner?.generation, driveSessionId]) : null;
  const loaded = useRef<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);

  useEffect(() => {
    if (!identity) loaded.current = null;
    let active = true;
    const isCurrentOwner = () => active && (!owner || ownerRuntime.isCurrent(owner));
    const isCurrent = () => isCurrentOwner() && getCurrentDriveSessionId() === driveSessionId;
    const refresh = async () => {
      if (!identity || !googleToken || !driveSessionId || !isCurrent() || navigator.onLine === false) return;
      const success = await loadLibraryFromDrive(googleToken, driveSessionId).catch(() => false);
      if (!isCurrent()) return;
      if (success) loaded.current = identity;
      else setIsOfflineMode(true);
      setSettled(identity);
    };
    const handleOnline = () => { void refresh(); };
    const handleOffline = () => { if (isCurrentOwner()) setIsOfflineMode(true); };
    if (identity && loaded.current !== identity) window.queueMicrotask(handleOnline);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      active = false;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [identity, driveSessionId, getCurrentDriveSessionId, googleToken, loadLibraryFromDrive, owner, setIsOfflineMode]);

  return Boolean(identity && settled !== identity && navigator.onLine !== false);
};
