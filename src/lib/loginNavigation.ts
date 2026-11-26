const FIREBASE_REDIRECT_KEY = 'web-reader:firebase-login-return';

export function myPageLoginHash(value: unknown): string {
  return typeof value === 'string' && value.length <= 4096 && /^#mypage(?:\/|\?|$)/.test(value) ? value : '';
}

export function libraryLandingView() {
  return myPageLoginHash(window.location?.hash) ? 'mypage' : 'shelf';
}

export function restoreLoginHash(returnHash: string) {
  const hash = myPageLoginHash(returnHash);
  if (window.location.hash === hash) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search + hash);
}

export function rememberFirebaseLoginRedirect() {
  try {
    sessionStorage.setItem(FIREBASE_REDIRECT_KEY, myPageLoginHash(window.location.hash));
  } catch { /* Firebase may still be able to sign in if app tab storage is unavailable. */ }
}

export function clearFirebaseLoginRedirect() {
  try { sessionStorage.removeItem(FIREBASE_REDIRECT_KEY); } catch { /* Tab storage is unavailable. */ }
}

export function readFirebaseLoginRedirect(): string | null {
  try {
    const hash = sessionStorage.getItem(FIREBASE_REDIRECT_KEY);
    return hash === null ? null : myPageLoginHash(hash);
  } catch {
    return null;
  }
}
