import { useCallback, useEffect, useRef, useState } from 'react';
import { waitForCurrentLocalCommits } from '../lib/localCommitTracker';

export const useServiceWorkerUpdate = () => {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const applyingRef = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let active = true;
    let registration: ServiceWorkerRegistration | null = null;

    const inspectWaiting = () => {
      if (active && registration?.waiting) setWaitingWorker(registration.waiting);
    };
    const inspectInstalling = () => {
      const installing = registration?.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          inspectWaiting();
        }
      });
    };

    void navigator.serviceWorker.register('/sw.js').then((nextRegistration) => {
      if (!active) return;
      registration = nextRegistration;
      inspectWaiting();
      nextRegistration.addEventListener('updatefound', inspectInstalling);
      inspectInstalling();
    }).catch(() => undefined);

    const reloadAfterActivation = () => {
      if (applyingRef.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', reloadAfterActivation);
    return () => {
      active = false;
      registration?.removeEventListener('updatefound', inspectInstalling);
      navigator.serviceWorker.removeEventListener('controllerchange', reloadAfterActivation);
    };
  }, []);

  const applyUpdate = useCallback(async () => {
    if (!waitingWorker || applyingRef.current) return;
    applyingRef.current = true;
    await waitForCurrentLocalCommits();
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }, [waitingWorker]);

  return { updateAvailable: Boolean(waitingWorker), applyUpdate };
};
