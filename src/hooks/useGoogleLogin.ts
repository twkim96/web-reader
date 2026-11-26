import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { signInWithPopup, signInWithRedirect, updateCurrentUser } from 'firebase/auth';
import { auth, getGooglePopupAuth, googleProvider, setGoogleRedirectCancelled } from '../lib/firebase';
import { clearFirebaseLoginRedirect, readFirebaseLoginRedirect, rememberFirebaseLoginRedirect, restoreLoginHash } from '../lib/loginNavigation';

type LoginAttempt = { mode: 'popup' | 'redirect'; committing: boolean; returning?: boolean };
type LoginPhase = 'waiting' | 'finishing';

export function useGoogleLogin(onError: (error: unknown) => void) {
  const attempt = useRef<LoginAttempt | null>(null);
  const [phase, setPhase] = useState<LoginPhase | null>(null);

  const finish = useCallback((authenticated = true) => {
    const current = attempt.current;
    if (!current || (!authenticated && !current.returning)) return;
    attempt.current = null;
    if (current.mode === 'redirect') clearFirebaseLoginRedirect();
    setPhase(null);
  }, []);
  const isReturning = useCallback(() => Boolean(attempt.current?.returning), []);

  useLayoutEffect(() => {
    const returnHash = readFirebaseLoginRedirect();
    if (returnHash !== null) {
      restoreLoginHash(returnHash);
      const returning: LoginAttempt = { mode: 'redirect', committing: false, returning: true };
      attempt.current = returning;
      // Restore the guard before the auth bootstrap can render a guest shelf.
      // The first server render shows only the library loading screen.
      window.queueMicrotask(() => {
        if (attempt.current === returning) setPhase('waiting');
      });
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || attempt.current?.mode !== 'redirect' || attempt.current.returning) return;
      finish();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      attempt.current = null;
    };
  }, [finish]);

  const start = (mode: LoginAttempt['mode']) => {
    if (attempt.current || auth.currentUser) return;
    const current: LoginAttempt = { mode, committing: false };
    attempt.current = current;
    setGoogleRedirectCancelled(false);
    setPhase('waiting');

    const logIn = async () => {
      if (mode === 'redirect') {
        rememberFirebaseLoginRedirect();
        await signInWithRedirect(auth, googleProvider);
        return;
      }

      const result = await signInWithPopup(getGooglePopupAuth(), googleProvider);
      if (attempt.current !== current || auth.currentUser) return;
      current.committing = true;
      setPhase('finishing');
      await updateCurrentUser(auth, result.user);
    };
    void logIn().then(() => {
      if (attempt.current !== current || current.committing) return;
      finish();
    }).catch((error: unknown) => {
      if (attempt.current !== current) return;
      finish();
      const code = (error as { code?: string } | null)?.code;
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
      onError(error);
    });
  };

  const cancel = () => {
    const current = attempt.current;
    if (!current || current.committing || auth.currentUser) return;
    attempt.current = null;
    setPhase(null);
    if (current.mode === 'redirect') {
      clearFirebaseLoginRedirect();
      setGoogleRedirectCancelled(true);
      window.location.reload();
    }
  };

  return { start, cancel, phase, finish, isReturning };
}
