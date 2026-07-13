import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('restores only the current-tab Drive session and reloads its library', async () => {
  const [tokenHook, networkHook] = await Promise.all([
    readFile(new URL('../src/hooks/useGoogleDriveToken.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useNetworkLibrarySync.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(tokenHook, /sessionStorage\.getItem\(DRIVE_TOKEN_SESSION_KEY\)/);
  assert.match(tokenHook, /sessionStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.doesNotMatch(tokenHook, /localStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.match(networkHook, /driveSessionId/);
  assert.match(networkHook, /loadLibraryFromDrive\(googleToken, driveSessionId\)/);
});
