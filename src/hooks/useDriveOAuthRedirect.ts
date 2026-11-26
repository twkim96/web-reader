import { Dispatch, SetStateAction, useCallback, useEffect } from 'react';
import { ViewState } from '../types';
import {
  buildGoogleDriveOAuthUrl,
  consumeGoogleDriveOAuthState,
  parseGoogleDriveOAuthResult,
  rememberGoogleDriveOAuthState,
} from '../lib/googleDriveOAuth';
import { libraryLandingView, restoreLoginHash } from '../lib/loginNavigation';

interface UseDriveOAuthRedirectOptions {
  saveToken: (token: string, expiresIn: number) => string;
  setView: Dispatch<SetStateAction<ViewState>>;
  setAuthErrorMessage: Dispatch<SetStateAction<string | null>>;
}

export const useDriveOAuthRedirect = ({
  saveToken,
  setView,
  setAuthErrorMessage,
}: UseDriveOAuthRedirectOptions) => {
  useEffect(() => {
    const result = parseGoogleDriveOAuthResult(window.location.hash);
    if (!result) return;
    const returnHash = consumeGoogleDriveOAuthState(
      sessionStorage,
      localStorage,
      result.state,
    );
    restoreLoginHash(returnHash ?? '');

    if (
      result.error
      || !result.accessToken
      || !Number.isFinite(result.expiresIn)
      || result.expiresIn <= 0
    ) {
      setAuthErrorMessage('Google Drive 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setView(libraryLandingView());
      return;
    }
    if (returnHash === null) {
      setAuthErrorMessage('Google Drive 연결 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
      setView(libraryLandingView());
      return;
    }

    saveToken(result.accessToken, result.expiresIn);
    setView((current) => current === 'loading' ? libraryLandingView() : current);
  }, [saveToken, setAuthErrorMessage, setView]);

  return useCallback((clientId: string) => {
    const state = crypto.randomUUID();
    if (!rememberGoogleDriveOAuthState(sessionStorage, localStorage, state, window.location.hash)) {
      setAuthErrorMessage('Google Drive 연결 상태를 저장하지 못했습니다. 다시 시도해 주세요.');
      return;
    }
    const redirectUri = `${window.location.origin}${window.location.pathname}`;
    window.location.assign(buildGoogleDriveOAuthUrl(clientId, redirectUri, state));
  }, [setAuthErrorMessage]);
};
