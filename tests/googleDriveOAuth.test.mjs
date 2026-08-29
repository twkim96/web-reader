import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoogleDriveOAuthUrl,
  clearPendingGoogleDriveOAuthStates,
  consumeGoogleDriveOAuthState,
  GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY,
  GOOGLE_DRIVE_OAUTH_STATE_KEY,
  GOOGLE_DRIVE_OAUTH_STATE_TTL_MS,
  hasPendingGoogleDriveOAuth,
  parseGoogleDriveOAuthResult,
  rememberGoogleDriveOAuthState,
} from '../src/lib/googleDriveOAuth.ts';

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
};

test('builds a same-page Drive redirect without GIS popup parameters', () => {
  const value = buildGoogleDriveOAuthUrl(
    'client.apps.googleusercontent.com',
    'https://reader.example/',
    'state-1',
  );
  const url = new URL(value);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://reader.example/');
  assert.equal(url.searchParams.get('response_type'), 'token');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.equal(url.searchParams.get('display'), null);
  assert.match(url.searchParams.get('scope'), /drive\.readonly/);
  assert.match(url.searchParams.get('scope'), /drive\.appdata/);
});

test('detects a pending redirect state for the shared bootstrap gate', () => {
  const session = createStorage({ [GOOGLE_DRIVE_OAUTH_STATE_KEY]: 'state-1' });
  const shared = createStorage();
  assert.equal(hasPendingGoogleDriveOAuth(
    session,
    shared,
    '#access_token=token&state=state-1',
  ), true);
  assert.equal(hasPendingGoogleDriveOAuth(session, shared, ''), false);
  assert.equal(hasPendingGoogleDriveOAuth(
    createStorage(),
    shared,
    '#access_token=token&state=state-1',
  ), false);
});

test('consumes the current-tab Drive OAuth state exactly once', () => {
  const session = createStorage();
  const shared = createStorage();
  assert.equal(rememberGoogleDriveOAuthState(session, shared, 'state-1', 1_000), true);
  assert.equal(session.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY), 'state-1');
  assert.equal(consumeGoogleDriveOAuthState(session, shared, 'state-1', 2_000), true);
  assert.equal(session.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY), null);
  assert.equal(shared.getItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY), null);
  assert.equal(consumeGoogleDriveOAuthState(session, shared, 'state-1', 2_001), false);
});

test('accepts a fresh shared state after the OAuth callback opens a new context', () => {
  const originalSession = createStorage();
  const callbackSession = createStorage();
  const shared = createStorage();
  rememberGoogleDriveOAuthState(originalSession, shared, 'state-pwa', 10_000);

  assert.equal(hasPendingGoogleDriveOAuth(
    callbackSession,
    shared,
    '#access_token=token&expires_in=3600&state=state-pwa',
    10_500,
  ), true);
  assert.equal(
    consumeGoogleDriveOAuthState(callbackSession, shared, 'state-pwa', 10_500),
    true,
  );
  assert.equal(
    consumeGoogleDriveOAuthState(callbackSession, shared, 'state-pwa', 10_501),
    false,
  );
});

test('rejects mismatched and expired shared OAuth states', () => {
  const session = createStorage();
  const shared = createStorage();
  rememberGoogleDriveOAuthState(session, shared, 'state-valid', 5_000);
  assert.equal(
    consumeGoogleDriveOAuthState(createStorage(), shared, 'state-wrong', 6_000),
    false,
  );
  assert.equal(
    consumeGoogleDriveOAuthState(
      createStorage(),
      shared,
      'state-valid',
      5_000 + GOOGLE_DRIVE_OAUTH_STATE_TTL_MS + 1,
    ),
    false,
  );
  assert.equal(shared.getItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY), null);
});

test('retains recent parallel states and clears every pending state on disconnect', () => {
  const session = createStorage();
  const shared = createStorage();
  for (let index = 0; index < 6; index += 1) {
    rememberGoogleDriveOAuthState(session, shared, `state-${index}`, 1_000 + index);
  }
  const pending = JSON.parse(shared.getItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY));
  assert.deepEqual(pending.map(({ state }) => state), [
    'state-2',
    'state-3',
    'state-4',
    'state-5',
  ]);
  assert.equal(
    consumeGoogleDriveOAuthState(createStorage(), shared, 'state-3', 2_000),
    true,
  );
  assert.equal(
    consumeGoogleDriveOAuthState(createStorage(), shared, 'state-4', 2_001),
    true,
  );

  clearPendingGoogleDriveOAuthStates(session, shared);
  assert.equal(session.getItem(GOOGLE_DRIVE_OAUTH_STATE_KEY), null);
  assert.equal(shared.getItem(GOOGLE_DRIVE_OAUTH_PENDING_STATES_KEY), null);
});

test('parses a Drive redirect fragment and ignores ordinary reader hashes', () => {
  assert.deepEqual(parseGoogleDriveOAuthResult(
    '#access_token=token-1&expires_in=3600&state=state-1',
  ), {
    accessToken: 'token-1',
    expiresIn: 3600,
    state: 'state-1',
    error: null,
  });
  assert.equal(parseGoogleDriveOAuthResult('#chapter-3'), null);
});
