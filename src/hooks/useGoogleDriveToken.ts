import { useCallback, useState } from 'react';

const TOKEN_KEY = 'google_drive_token';
const EXPIRY_KEY = 'google_drive_token_expiry';

const removeTokenFromStorage = () => {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRY_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
};

const getValidTokenFromStorage = () => {
  const sessionToken = sessionStorage.getItem(TOKEN_KEY);
  const sessionExpiry = sessionStorage.getItem(EXPIRY_KEY);
  if (sessionToken && sessionExpiry && Date.now() < parseInt(sessionExpiry, 10)) {
    return sessionToken;
  }

  const localToken = localStorage.getItem(TOKEN_KEY);
  const localExpiry = localStorage.getItem(EXPIRY_KEY);
  if (localToken && localExpiry && Date.now() < parseInt(localExpiry, 10)) {
    return localToken;
  }

  removeTokenFromStorage();
  return null;
};

export const useGoogleDriveToken = () => {
  const [googleToken, setGoogleToken] = useState<string | null>(null);

  const getStoredToken = useCallback(() => getValidTokenFromStorage(), []);

  const saveToken = useCallback((token: string, expiresIn: number) => {
    const expiryTime = (Date.now() + expiresIn * 1000).toString();

    removeTokenFromStorage();
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EXPIRY_KEY, expiryTime);
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
