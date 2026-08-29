import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { runLogoutFlow } from '../src/lib/logoutFlow.ts';

test('keeps local owner cleanup behind successful Firebase sign-out', async () => {
  const events = [];
  const result = await runLogoutFlow({
    prepareUi: () => events.push('prepare-ui'),
    signOut: async () => events.push('firebase-sign-out'),
    commitLocalCleanup: () => events.push('local-cleanup'),
    recoverUi: () => events.push('recover-ui'),
  });

  assert.equal(result, true);
  assert.deepEqual(events, ['prepare-ui', 'firebase-sign-out', 'local-cleanup']);
});

test('recovers the shelf without clearing local owner state when sign-out fails', async () => {
  const events = [];
  const failure = new Error('offline');
  let recoveredError;
  const result = await runLogoutFlow({
    prepareUi: () => events.push('prepare-ui'),
    signOut: async () => {
      events.push('firebase-sign-out');
      throw failure;
    },
    commitLocalCleanup: () => events.push('local-cleanup'),
    recoverUi: (error) => {
      recoveredError = error;
      events.push('recover-ui');
    },
  });

  assert.equal(result, false);
  assert.equal(recoveredError, failure);
  assert.deepEqual(events, ['prepare-ui', 'firebase-sign-out', 'recover-ui']);
});

test('lets the Firebase auth callback perform exactly one guest-library transition on logout', async () => {
  const [page, authBootstrap] = await Promise.all([
    readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useAuthBootstrap.ts', import.meta.url), 'utf8'),
  ]);
  const logoutAction = page.match(
    /if \(action === 'logout'\) \{([\s\S]*?)\n    \} else if \(action === 'disconnect'\)/,
  )?.[1] ?? '';
  const prepareUi = logoutAction.match(
    /prepareUi: \(\) => \{([\s\S]*?)\n        \},\n        signOut:/,
  )?.[1] ?? '';
  const cleanup = logoutAction.match(
    /commitLocalCleanup: \(\) => \{([\s\S]*?)\n        \},\n        recoverUi:/,
  )?.[1] ?? '';
  const recovery = logoutAction.match(
    /recoverUi: \(error\) => \{([\s\S]*?)\n        \},/,
  )?.[1] ?? '';

  assert.match(prepareUi, /isGuestRef\.current = true/);
  assert.match(prepareUi, /localStorage\.setItem\('isGuest', 'true'\)/);
  assert.match(prepareUi, /ownerRuntime\.clear\(\)/);
  assert.doesNotMatch(prepareUi, /setView\('loading'\)/);
  assert.doesNotMatch(cleanup, /ownerRuntime\.clear|resetLibraryState|setBooks|enterGuestShelf/);
  assert.match(cleanup, /clearPendingGoogleDriveOAuthStates\(sessionStorage, localStorage\)/);
  assert.doesNotMatch(cleanup, /window\.(?:location|history)/);
  assert.match(recovery, /isGuestRef\.current = false/);
  assert.match(recovery, /ownerRuntime\.activate\(logoutOwner\.ownerKey\)/);
  assert.match(recovery, /localStorage\.removeItem\('isGuest'\)/);
  assert.match(authBootstrap, /if \(firebaseUser\) \{\s+\/\/[^\n]+\n\s+\/\/[^\n]+\n\s+guestRestore = null;/);
  assert.match(authBootstrap, /else if \(isGuestRef\.current\) \{\s+setIsGuest\(true\);\s+activateGuest/);
  assert.match(authBootstrap, /if \(!isActive \|\| initialAuthSettled \|\| isGuestRef\.current \|\| auth\.currentUser\) return;/);
  assert.match(authBootstrap, /enterGuestLibrary\(\+\+authGeneration\);/);
  assert.match(authBootstrap, /window\.clearTimeout\(authFallbackTimer\)/);
});
