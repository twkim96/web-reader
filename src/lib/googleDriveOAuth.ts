export const GOOGLE_DRIVE_TOKEN_KEY = 'google_drive_token';
export const GOOGLE_DRIVE_TOKEN_EXPIRY_KEY = 'google_drive_token_expiry';
export const GOOGLE_DRIVE_OAUTH_STATE_KEY = 'google_drive_oauth_state';
export const GOOGLE_DRIVE_OAUTH_ERROR_KEY = 'google_drive_oauth_error';

export const GOOGLE_DRIVE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_DRIVE_OAUTH_CALLBACK_PATH = '/drive-oauth';

export const buildGoogleDriveOAuthUrl = (clientId: string, origin: string, state: string) => {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}${GOOGLE_DRIVE_OAUTH_CALLBACK_PATH}`,
    response_type: 'token',
    scope: GOOGLE_DRIVE_OAUTH_SCOPE,
    prompt: 'select_account',
    include_granted_scopes: 'true',
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};
