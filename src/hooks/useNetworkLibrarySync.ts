import { Dispatch, SetStateAction, useEffect } from 'react';
import { User as FirebaseUser } from 'firebase/auth';

interface UseNetworkLibrarySyncOptions {
  user: FirebaseUser | null;
  googleToken: string | null;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
}

export const useNetworkLibrarySync = ({
  user,
  googleToken,
  setIsOfflineMode,
  loadLibraryFromDrive,
}: UseNetworkLibrarySyncOptions) => {
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
