import { myPageLoginHash } from './loginNavigation.ts';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');

export const GOOGLE_DRIVE_OAUTH_STATE_KEY = 'google_drive_oauth_state_v2';
export const GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY = 'google_drive_oauth_pending_states_v1';
export const GOOGLE_DRIVE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const MAX_PENDING_GOOGLE_DRIVE_OAUTH_STATES = 4;

type OAuthStateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type PendingGoogleDriveOAuthState = {
  state: string;
  createdAt: number;
  returnHash?: string;
};

const isValidStateValue = (value: unknown): value is string => (
  typeof value === 'string' && value.length > 0 && value.length <= 256
);

function isStoredOAuthState(entry: unknown): entry is PendingGoogleDriveOAuthState {
  return typeof entry === 'object' && entry !== null
    && 'state' in entry && isValidStateValue(entry.state)
    && 'createdAt' in entry && typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt);
}

function readTabState(session: Pick<Storage, 'getItem'>): Pick<PendingGoogleDriveOAuthState, 'state' | 'returnHash'> | null {
  try {
    const saved = session.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);
    if (saved?.startsWith('{')) {
      const entry: unknown = JSON.parse(saved);
      return isStoredOAuthState(entry) ? entry : null;
    }
    return isValidStateValue(saved) ? { state: saved, returnHash: '' } : null;
  } catch {
    return null;
  }
}

const readPendingGoogleDriveOAuthStates = (
  storage: Pick<Storage, 'getItem'>,
  now: number,
): PendingGoogleDriveOAuthState[] => {
  try {
    const serialized = storage.getItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY);
    if (!serialized) return [];
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => isStoredOAuthState(entry)
      && entry.createdAt <= now && now - entry.createdAt <= GOOGLE_DRIVE_OAUTH_STATE_TTL_MS);
  } catch {
    return [];
  }
};

const writePendingGoogleDriveOAuthStates = (
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  states: PendingGoogleDriveOAuthState[],
) => {
  try {
    if (states.length === 0) {
      storage.removeItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY);
    } else {
      storage.setItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY, JSON.stringify(states));
    }
    return true;
  } catch {
    return false;
  }
};

export const rememberGoogleDriveOAuthState = (
  session: Pick<Storage, 'setItem'>,
  shared: OAuthStateStorage,
  state: string,
  returnHash = '',
  now = Date.now(),
) => {
  if (!isValidStateValue(state)) return false;
  const entry = { state, createdAt: now, returnHash: myPageLoginHash(returnHash) };

  let storedInSession = false;
  try {
    session.setItem(GOOGLE_DRIVE_OAUTH_STATE_KEY, JSON.stringify(entry));
    storedInSession = true;
  } catch {
    // The same-origin fallback below can still bridge a PWA relaunch.
  }

  const pending = readPendingGoogleDriveOAuthStates(shared, now)
    .filter((entry) => entry.state !== state);
  pending.push(entry);
  const storedInShared = writePendingGoogleDriveOAuthStates(
    shared,
    pending.slice(-MAX_PENDING_GOOGLE_DRIVE_OAUTH_STATES),
  );
  return storedInSession || storedInShared;
};

export const consumeGoogleDriveOAuthState = (
  session: Pick<Storage, 'getItem' | 'removeItem'>,
  shared: OAuthStateStorage,
  returnedState: string | null,
  now = Date.now(),
) => {
  const sessionState = readTabState(session);
  try {
    if (!sessionState || sessionState.state === returnedState) session.removeItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);
  } catch {
    // The shared pending-state record remains available.
  }

  const pending = readPendingGoogleDriveOAuthStates(shared, now);
  const match = sessionState?.state === returnedState ? sessionState : pending.find((entry) => entry.state === returnedState);
  writePendingGoogleDriveOAuthStates(
    shared,
    pending.filter((entry) => entry.state !== returnedState),
  );

  return match ? myPageLoginHash(match.returnHash) : null;
};

export const clearPendingGoogleDriveOAuthStates = (
  session: Pick<Storage, 'removeItem'>,
  shared: Pick<Storage, 'removeItem'>,
) => {
  try {
    session.removeItem(GOOGLE_DRIVE_OAUTH_STATE_KEY);
  } catch {
    // Nothing else is required when this storage is unavailable.
  }
  try {
    shared.removeItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY);
  } catch {
    // Nothing else is required when this storage is unavailable.
  }
};

export const hasPendingGoogleDriveOAuth = (
  session: Pick<Storage, 'getItem'>,
  shared: Pick<Storage, 'getItem'>,
  hash: string,
  now = Date.now(),
) => {
  const result = parseGoogleDriveOAuthResult(hash);
  if (!result || !isValidStateValue(result.state)) return false;
  if (readTabState(session)?.state === result.state) return true;
  return readPendingGoogleDriveOAuthStates(shared, now)
    .some((entry) => entry.state === result.state);
};

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
  if (myPageLoginHash(hash)) return null;
  const value = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(value);
  if (!params.has('access_token') && !params.has('error')) return null;
  const expiresIn = Number(params.get('expires_in'));
  return {
    accessToken: params.get('access_token'),
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0,
    state: params.get('state'),
    error: params.get('error'),
  };
};
