'use client';

import { useEffect } from 'react';
import {
  GOOGLE_DRIVE_OAUTH_ERROR_KEY,
  GOOGLE_DRIVE_OAUTH_STATE_KEY,
  GOOGLE_DRIVE_TOKEN_EXPIRY_KEY,
  GOOGLE_DRIVE_TOKEN_KEY,
} from '../../lib/googleDriveOAuth';

const getOAuthHashParams = () => {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(hash);
};

const redirectHome = () => {
  window.location.replace('/');
};

const setDriveOAuthError = (message: string) => {
  sessionStorage.setItem(GOOGLE_DRIVE_OAUTH_ERROR_KEY, message);
};

export default function DriveOAuthPage() {
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const params = getOAuthHashParams();
      const accessToken = params.get('access_token');
      const expiresIn = Number(params.get('expires_in'));
      const state = params.get('state');
      const expectedState = sessionStorage.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);

      sessionStorage.removeItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);
      window.history.replaceState(null, '', window.location.pathname);

      if (params.get('error')) {
        setDriveOAuthError('Google Drive 연결이 취소되었거나 승인되지 않았습니다.');
        redirectHome();
        return;
      }

      if (!expectedState || state !== expectedState) {
        setDriveOAuthError('Google Drive 연결 상태를 확인하지 못했습니다. 다시 시도해 주세요.');
        redirectHome();
        return;
      }

      if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        setDriveOAuthError('Google Drive 연결 권한을 확인하지 못했습니다. 다시 시도해 주세요.');
        redirectHome();
        return;
      }

      localStorage.setItem(GOOGLE_DRIVE_TOKEN_KEY, accessToken);
      localStorage.setItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY, (Date.now() + expiresIn * 1000).toString());
      sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_KEY);
      sessionStorage.removeItem(GOOGLE_DRIVE_TOKEN_EXPIRY_KEY);
      redirectHome();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#f4ecd8] text-[#5c4b37] gap-4">
      <div className="w-12 h-12 border-4 border-[#d4af37] border-t-transparent rounded-full animate-spin" />
      <p className="font-black uppercase tracking-widest text-xs opacity-50">Connecting Google Drive...</p>
    </div>
  );
}
