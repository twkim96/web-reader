import { useCallback, useState } from 'react';
import { GOOGLE_DRIVE_TOKEN_EXPIRY_KEY, GOOGLE_DRIVE_TOKEN_KEY } from '../lib/googleDriveOAuth';

const removeTokenFromStorage = () => {
  localStorage.removeItem(GOOGLE_DRIVE_TOKEN_KEY);
  localStorage.removeItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY);
  sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_KEY);
  sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY);
};

const getValidTokenFromStorage = () => {
  const sessionToken = sessionStorage.getItem(GOOGLE_DRIVE_TOKEN_KEY);
  const sessionExpiry = sessionStorage.getItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY);
  if (sessionToken && sessionExpiry && Date.now() < parseInt(sessionExpiry, 10)) {
    return sessionToken;
  }

  const localToken = localStorage.getItem(GOOGLE_DRIVE_TOKEN_KEY);
  const localExpiry = localStorage.getItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY);
  if (localToken && localExpiry && Date.now() < parseInt(localExpiry, 10)) {
    return localToken;
  }

  removeTokenFromStorage();
  return null;
};

export const useGoogleDriveToken = () => {
  const [googleToken, setGoogleToken] = useState<string | null>(null);

  const getStoredToken = useCallback(() => getValidTokenFromStorage(), []);

  const saveToken = useCallback((token: string, expiresIn: number, sessionOnly: boolean) => {
    const expiryTime = (Date.now() + expiresIn * 1000).toString();
    const storage = sessionOnly ? sessionStorage : localStorage;

    removeTokenFromStorage();
    storage.setItem(GOOGLE_DRIVE_TOKEN_KEY, token);
    storage.setItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY, expiryTime);
    setGoogleToken(token);
  }, []);

  const clearToken = useCallback(() => {
    removeTokenFromStorage();
    setGoogleToken(null);
  }, []);

  const hasValidToken = useCallback(() => {
    if (!googleToken) return false;
    return getValidTokenFromStorage() === googleToken;
  }, [googleToken]);

  return {
    googleToken,
    setGoogleToken,
    getStoredToken,
    saveToken,
    clearToken,
    hasValidToken,
  };
};
