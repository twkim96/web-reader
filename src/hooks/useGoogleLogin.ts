import { useCallback, useEffect, useRef, useState } from 'react';
import { signInWithPopup, signInWithRedirect, updateCurrentUser } from 'firebase/auth';
import { auth, getGooglePopupAuth, googleProvider, setGoogleRedirectCancelled } from '../lib/firebase';

type LoginAttempt = { mode: 'popup' | 'redirect'; committing: boolean };
type LoginPhase = 'waiting' | 'finishing';

export function useGoogleLogin(onError: (error: unknown) => void) {
  const attempt = useRef<LoginAttempt | null>(null);
  const [phase, setPhase] = useState<LoginPhase | null>(null);

  const finish = useCallback(() => {
    if (!attempt.current) return;
    attempt.current = null;
    setPhase(null);
  }, []);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || attempt.current?.mode !== 'redirect') return;
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
      attempt.current = null;
      setPhase(null);
    }).catch((error: unknown) => {
      if (attempt.current !== current) return;
      attempt.current = null;
      setPhase(null);
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
      setGoogleRedirectCancelled(true);
      window.location.reload();
    }
  };

  return { start, cancel, phase, finish };
}
