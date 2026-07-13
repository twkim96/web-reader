import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoogleDriveOAuthUrl,
  GOOGLE_DRIVE_OAUTH_STATE_KEY,
  hasPendingGoogleDriveOAuth,
  parseGoogleDriveOAuthResult,
} from '../src/lib/googleDriveOAuth.ts';

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
  const storage = {
    getItem: (key) => key === GOOGLE_DRIVE_OAUTH_STATE_KEY ? 'state-1' : null,
  };
  assert.equal(hasPendingGoogleDriveOAuth(storage, '#access_token=token&state=state-1'), true);
  assert.equal(hasPendingGoogleDriveOAuth(storage, ''), false);
  assert.equal(hasPendingGoogleDriveOAuth(
    { getItem: () => null },
    '#access_token=token&state=state-1',
  ), false);
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
