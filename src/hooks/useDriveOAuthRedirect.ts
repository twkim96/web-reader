import { Dispatch, SetStateAction, useCallback, useRef } from 'react';
import { ViewState } from '../types';
import { DriveTokenRequestSingleFlight } from '../lib/driveTokenMemory';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

interface UseDriveOAuthRedirectOptions {
  saveToken: (token: string, expiresIn: number) => string;
  setIsOfflineMode: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<ViewState>>;
  loadLibraryFromDrive: (token: string, driveSessionId?: string) => Promise<boolean>;
  setAuthErrorMessage: Dispatch<SetStateAction<string | null>>;
}

export const useDriveOAuthRedirect = ({
  saveToken,
  setIsOfflineMode,
  setView,
  loadLibraryFromDrive,
  setAuthErrorMessage,
}: UseDriveOAuthRedirectOptions) => {
  const requesterRef = useRef<DriveTokenRequestSingleFlight | null>(null);
  if (requesterRef.current == null) requesterRef.current = new DriveTokenRequestSingleFlight();

  return useCallback((clientId: string) => {
    const oauth = window.google?.accounts?.oauth2;
    if (!oauth) {
      setAuthErrorMessage('Google 인증 라이브러리를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
      return Promise.resolve();
    }
    return requesterRef.current!.run(() => new Promise<void>((resolve) => {
      const finish = resolve;
      const client = oauth.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPES,
        callback: (response) => {
          const expiresIn = Number(response.expires_in);
          if (response.error || !response.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
            setAuthErrorMessage('Google Drive 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            setView('shelf');
            finish();
            return;
          }
          const driveSessionId = saveToken(response.access_token, expiresIn);
          setIsOfflineMode(false);
          setView('loading');
          void loadLibraryFromDrive(response.access_token, driveSessionId).finally(() => {
            setView('shelf');
            finish();
          });
        },
        error_callback: () => {
          setAuthErrorMessage('Google Drive 연결 창이 닫혔거나 열리지 않았습니다. 다시 시도해 주세요.');
          setView('shelf');
          finish();
        },
      });
      client.requestAccessToken({ prompt: 'select_account' });
    }));
  }, [loadLibraryFromDrive, saveToken, setAuthErrorMessage, setIsOfflineMode, setView]);
};
