import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

test('restores only the current-tab Drive session and reloads its library', async () => {
  const [tokenHook, networkHook] = await Promise.all([
    readFile(new URL('../src/hooks/useGoogleDriveToken.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useNetworkLibrarySync.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(tokenHook, /sessionStorage\.getItem\(DRIVE_TOKEN_SESSION_KEY\)/);
  assert.match(tokenHook, /sessionStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.doesNotMatch(tokenHook, /localStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
  assert.match(networkHook, /driveSessionId/);
  assert.match(networkHook, /isAuthenticatedLibraryReady/);
  assert.match(networkHook, /loadLibraryFromDrive\(googleToken, driveSessionId\)/);
});

test('bridges only the short-lived OAuth state across browser contexts', async () => {
  const [oauthHook, oauthState, tokenHook] = await Promise.all([
    readFile(new URL('../src/hooks/useDriveOAuthRedirect.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/googleDriveOAuth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useGoogleDriveToken.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(oauthHook, /rememberGoogleDriveOAuthState\(sessionStorage, localStorage, state, window\.location\.hash\)/);
  assert.match(oauthHook, /consumeGoogleDriveOAuthState\(\s*sessionStorage,\s*localStorage,/);
  assert.match(oauthState, /GOOGLE_DRIVE_OAUTH_STATE_TTL_MS = 10 \* 60 \* 1000/);
  const rememberState = oauthState.match(
    /export const rememberGoogleDriveOAuthState = \(([\s\S]*?)\n\};/,
  )?.[0] ?? '';
  assert.match(rememberState, /writePendingGoogleDriveOAuthStates/);
  assert.doesNotMatch(rememberState, /accessToken|DRIVE_TOKEN_SESSION_KEY/);
  assert.doesNotMatch(tokenHook, /localStorage\.setItem\(DRIVE_TOKEN_SESSION_KEY/);
});

test('keeps the guest shelf active while Firebase redirects so login cancellation can recover', async () => {
  const [page, loginHook] = await Promise.all([
    readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/hooks/useGoogleLogin.ts', import.meta.url), 'utf8'),
  ]);
  const loginHandler = page.match(
    /const handleLoginTrigger = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1] ?? '';

  assert.match(loginHandler, /setLoginDisclosureMode\(null\)/);
  assert.match(loginHandler, /googleLogin\.start\(usePopup \? 'popup' : 'redirect'\)/);
  assert.match(loginHook, /signInWithRedirect\(auth, googleProvider\)/);
  assert.doesNotMatch(loginHandler, /setView\(['"]loading['"]\)/);
  assert.doesNotMatch(loginHandler, /localStorage\.removeItem\(['"]isGuest['"]\)/);
  assert.doesNotMatch(loginHandler, /ownerRuntime\.clear\(\)/);
  assert.doesNotMatch(loginHandler, /resetLibraryState\(\)/);
});

test('Firebase uses the registered branch host only on the matching preview origin', () => {
  const registered = 'twreader-git-preview-mypage-twkims-projects-b9c7f5a3.vercel.app';
  const preview = 'another-deployment.vercel.app';
  const production = 'twreader.vercel.app';
  const tailnet = 'dev.team.ts.net';
  const hostedAuth = 'demo-web-reader.firebaseapp.com';
  const readAuthDomain = (vercelEnv, branch, host, nodeEnv = 'production') => execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', `
      const config = (await import('./next.config.ts')).default;
      Object.assign(process.env, (config.default ?? config).env);
      globalThis.window = { location: new URL('https://' + process.env.TEST_AUTH_HOST) };
      const firebase = await import('./src/lib/firebase.ts');
      console.log((firebase.auth ?? firebase.default.auth).config.authDomain);
    `,
  ], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      VERCEL_ENV: vercelEnv,
      VERCEL_BRANCH_URL: branch,
      WEB_READER_TAILSCALE_DEV_HOST: tailnet,
      NEXT_PUBLIC_FIREBASE_API_KEY: 'test-api-key',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-web-reader',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: production,
      TEST_AUTH_HOST: host,
    },
    encoding: 'utf8',
  }).trim();

  assert.equal(readAuthDomain('preview', registered, registered), registered);
  assert.equal(readAuthDomain('preview', registered, preview), hostedAuth);
  assert.equal(readAuthDomain('preview', preview, preview), hostedAuth);
  assert.equal(readAuthDomain('production', registered, production), production);
  assert.equal(readAuthDomain('development', '', tailnet + ':8443', 'development'), hostedAuth);
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
