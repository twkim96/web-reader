import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearLegacyDriveTokenArtifacts,
  DriveTokenMemory,
  hasLegacyOAuthFragment,
} from '../lib/driveTokenMemory';

export const useGoogleDriveToken = () => {
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [driveSessionId, setDriveSessionId] = useState<string | null>(null);
  const memoryRef = useRef<DriveTokenMemory | null>(null);
  if (memoryRef.current == null) memoryRef.current = new DriveTokenMemory();

  useEffect(() => {
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    const hash = window.location.hash;
    if (hasLegacyOAuthFragment(hash)) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }, []);

  const saveToken = useCallback((token: string, expiresIn: number) => {
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    const sessionId = memoryRef.current!.save(token, expiresIn);
    setDriveSessionId(sessionId);
    setGoogleToken(token);
    return sessionId;
  }, []);

  const clearToken = useCallback(() => {
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    memoryRef.current!.clear();
    setDriveSessionId(null);
    setGoogleToken(null);
  }, []);

  const hasValidToken = useCallback(() => {
    return memoryRef.current!.isValid();
  }, []);

  const revokeToken = useCallback(async () => {
    const token = googleToken;
    if (!token) return;
    await new Promise<void>((resolve) => {
      const revoke = window.google?.accounts?.oauth2?.revoke;
      if (!revoke) return resolve();
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      revoke(token, finish);
      window.setTimeout(finish, 1_500);
    });
  }, [googleToken]);

  return {
    googleToken,
    driveSessionId,
    saveToken,
    clearToken,
    hasValidToken,
    revokeToken,
  };
};
