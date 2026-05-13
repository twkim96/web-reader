import { Dispatch, SetStateAction, useCallback, useEffect } from 'react';
import { ViewState } from '../types';

const DRIVE_OAUTH_STATE_KEY = 'google_drive_oauth_state';

const getDriveRedirectUri = () => `${window.location.origin}${window.location.pathname}`;

const buildDriveOAuthUrl = (clientId: string, state: string) => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getDriveRedirectUri(),
    response_type: 'token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    prompt: 'select_account',
    include_granted_scopes: 'true',
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

const getDriveOAuthRedirectResult = () => {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash.includes('access_token=') && !hash.includes('error=')) return null;

  const params = new URLSearchParams(hash);
  const expiresIn = params.get('expires_in');
  return {
    accessToken: params.get('access_token'),
    expiresIn: expiresIn ? Number(expiresIn) : null,
    state: params.get('state'),
    error: params.get('error'),
  };
};

interface UseDriveOAuthRedirectOptions {
  saveToken: (token: string, expiresIn: number) => void;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  loadLibraryFromDrive: (token: string) => Promise<boolean>;
  setAuthErrorMessage: Dispatch<SetStateAction<string | null>>;
}

export const useDriveOAuthRedirect = ({
  saveToken,
  setIsOfflineMode,
  setView,
  loadLibraryFromDrive,
  setAuthErrorMessage,
}: UseDriveOAuthRedirectOptions) => {
  useEffect(() => {
    const result = getDriveOAuthRedirectResult();
    if (!result) return;

    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);

    const timeoutId = window.setTimeout(() => {
      const expectedState = sessionStorage.getItem(DRIVE_OAUTH_STATE_KEY);
      sessionStorage.removeItem(DRIVE_OAUTH_STATE_KEY);

      if (result.error || !result.accessToken || !Number.isFinite(result.expiresIn) || !result.expiresIn) {
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
      loadLibraryFromDrive(result.accessToken).then(() => {
        setView('shelf');
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [loadLibraryFromDrive, saveToken, setAuthErrorMessage, setIsOfflineMode, setView]);

  return useCallback((clientId: string) => {
    const state = crypto.randomUUID();
    sessionStorage.setItem(DRIVE_OAUTH_STATE_KEY, state);
    window.location.assign(buildDriveOAuthUrl(clientId, state));
  }, []);
};
