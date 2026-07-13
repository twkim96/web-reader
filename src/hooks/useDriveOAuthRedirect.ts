import { Dispatch, SetStateAction, useCallback, useEffect } from 'react';
import { ViewState } from '../types';
import {
  buildGoogleDriveOAuthUrl,
  parseGoogleDriveOAuthResult,
} from '../lib/googleDriveOAuth';

const DRIVE_OAUTH_STATE_KEY = 'google_drive_oauth_state_v2';

interface UseDriveOAuthRedirectOptions {
  saveToken: (token: string, expiresIn: number) => string;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  setAuthErrorMessage: Dispatch<SetStateAction<string | null>>;
}

export const useDriveOAuthRedirect = ({
  saveToken,
  setIsOfflineMode,
  setView,
  setAuthErrorMessage,
}: UseDriveOAuthRedirectOptions) => {
  useEffect(() => {
    const result = parseGoogleDriveOAuthResult(window.location.hash);
    if (!result) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    let active = true;

    window.queueMicrotask(() => {
      const expectedState = sessionStorage.getItem(DRIVE_OAUTH_STATE_KEY);
      sessionStorage.removeItem(DRIVE_OAUTH_STATE_KEY);
      if (!active) return;

      if (
        result.error
        || !result.accessToken
        || !Number.isFinite(result.expiresIn)
        || result.expiresIn <= 0
      ) {
        setAuthErrorMessage('Google Drive 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
        setView('shelf');
        return;
      }
      if (!expectedState || result.state !== expectedState) {
        setAuthErrorMessage('Google Drive 연결 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
        setView('shelf');
        return;
      }

      saveToken(result.accessToken, result.expiresIn);
      setIsOfflineMode(false);
      setView('loading');
    });

    return () => {
      active = false;
    };
  }, [saveToken, setAuthErrorMessage, setIsOfflineMode, setView]);

  return useCallback((clientId: string) => {
    const state = crypto.randomUUID();
    sessionStorage.setItem(DRIVE_OAUTH_STATE_KEY, state);
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    window.location.assign(buildGoogleDriveOAuthUrl(clientId, redirectUri, state));
  }, []);
};
