import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clearLegacyDriveTokenArtifacts,
  DRIVE_TOKEN_SESSION_KEY,
  DriveTokenMemory,
} from '../lib/driveTokenMemory';

export const useGoogleDriveToken = () => {
  const memoryRef = useRef<DriveTokenMemory | null>(null);
  if (memoryRef.current == null) memoryRef.current = new DriveTokenMemory();
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  const [driveSessionId, setDriveSessionId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    try {
      const serialized = sessionStorage.getItem(DRIVE_TOKEN_SESSION_KEY);
      const restored = serialized
        ? memoryRef.current!.restore(JSON.parse(serialized))
        : false;
      if (!restored) {
        sessionStorage.removeItem(DRIVE_TOKEN_SESSION_KEY);
      } else {
        window.queueMicrotask(() => {
          if (!active) return;
          setGoogleToken(memoryRef.current!.getToken());
          setDriveSessionId(memoryRef.current!.getSessionId());
        });
      }
    } catch {
      try {
        sessionStorage.removeItem(DRIVE_TOKEN_SESSION_KEY);
      } catch {
        // Keep the token memory-only if this browser blocks sessionStorage.
      }
    }
    return () => {
      active = false;
    };
  }, []);

  const saveToken = useCallback((token: string, expiresIn: number) => {
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    const sessionId = memoryRef.current!.save(token, expiresIn);
    const snapshot = memoryRef.current!.snapshot();
    if (snapshot) {
      try {
        sessionStorage.setItem(DRIVE_TOKEN_SESSION_KEY, JSON.stringify(snapshot));
      } catch {
        // The active page can still use the in-memory token.
      }
    }
    setDriveSessionId(sessionId);
    setGoogleToken(token);
    return sessionId;
  }, []);

  const clearToken = useCallback(() => {
    clearLegacyDriveTokenArtifacts(localStorage, sessionStorage);
    try {
      sessionStorage.removeItem(DRIVE_TOKEN_SESSION_KEY);
    } catch {
      // Nothing else is required when storage is unavailable.
    }
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
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 1_500);
    try {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
        signal: controller.signal,
      });
    } catch {
      // Local disconnect still completes if remote revocation is blocked.
    } finally {
      window.clearTimeout(timeoutId);
    }
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
