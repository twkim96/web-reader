import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('restores only the current-tab Drive session and reloads its library', async () => {
  const [tokenHook, networkHook, authHook] = await Promise.all([
    readFile(new URL('../src/hooks/useGoogleDriveToken.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useNetworkLibrarySync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useAuthBootstrap.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(tokenHook, /sessionStorage\.getItem\(DRIVE_TOKEN_SESSION_KEY\)/);
  assert.match(tokenHook, /sessionStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.doesNotMatch(tokenHook, /localStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.match(networkHook, /driveSessionId/);
  assert.match(networkHook, /isAuthenticatedLibraryReady/);
  assert.match(networkHook, /loadLibraryFromDrive\(googleToken, driveSessionId\)/);
  assert.match(authHook, /shouldHoldShelfForDrive\(\)/);
  const authenticatedDriveGate = authHook.indexOf('shouldHoldShelfForDrive()');
  assert.ok(
    authenticatedDriveGate < authHook.indexOf('setIsOfflineMode(true)', authenticatedDriveGate),
  );
});

test('keeps the guest shelf active while Firebase redirects so login cancellation can recover', async () => {
  const page = await readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8');
  const loginHandler = page.match(
    /const handleLoginTrigger = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? '';

  assert.match(loginHandler, /setLoginDisclosureMode\(null\)/);
  assert.match(loginHandler, /signInWithRedirect\(auth, googleProvider\)/);
  assert.match(loginHandler, /void enterGuestShelf\(\)/);
  assert.doesNotMatch(loginHandler, /setView\(['"]loading['"]\)/);
  assert.doesNotMatch(loginHandler, /localStorage\.removeItem\(['"]isGuest['"]\)/);
  assert.doesNotMatch(loginHandler, /ownerRuntime\.clear\(\)/);
  assert.doesNotMatch(loginHandler, /resetLibraryState\(\)/);
});

test('shows privacy disclosure before both Firebase login and Drive OAuth', async () => {
  const [page, modal] = await Promise.all([
    readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/LoginDisclosureModal.tsx', import.meta.url), 'utf8'),
  ]);
  const connectHandler = page.match(
    /const handleConnect = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? '';
  const driveConfirmHandler = page.match(
    /const handleDriveConnectTrigger = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? '';

  assert.match(connectHandler, /setLoginDisclosureMode\('firebase'\)/);
  assert.match(connectHandler, /setLoginDisclosureMode\('drive'\)/);
  assert.doesNotMatch(connectHandler, /startDriveOAuth/);
  assert.match(driveConfirmHandler, /startDriveOAuth\(clientId\)/);
  assert.match(page, /onConfirm=\{loginDisclosureMode === 'firebase' \? handleLoginTrigger : handleDriveConnectTrigger\}/);
  assert.match(modal, /data-login-disclosure-mode=\{mode\}/);
  assert.match(modal, /mode === 'firebase'/);
  assert.match(modal, /aria-label=\{mode === 'firebase' \? 'Google 계정으로 로그인' : 'Google Drive에 로그인'\}/);
  assert.equal((modal.match(/<GoogleSignInButtonAsset/g) ?? []).length, 1);
});
