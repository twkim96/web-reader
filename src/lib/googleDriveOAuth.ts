const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

export const GOOGLE_DRIVE_OAUTH_STATE_KEY = 'google_drive_oauth_state_v2';

export const hasPendingGoogleDriveOAuth = (
  storage: Pick<Storage, 'getItem'>,
  hash: string,
) => Boolean(
  storage.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY)
  && parseGoogleDriveOAuthResult(hash),
);

export const buildGoogleDriveOAuthUrl = (
  clientId: string,
  redirectUri: string,
  state: string,
) => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPES,
    prompt: 'select_account',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

export const parseGoogleDriveOAuthResult = (hash: string) => {
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!value.includes('access_token=') && !value.includes('error=')) return null;
  const params = new URLSearchParams(value);
  const expiresIn = Number(params.get('expires_in'));
  return {
    accessToken: params.get('access_token'),
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0,
    state: params.get('state'),
    error: params.get('error'),
  };
};
