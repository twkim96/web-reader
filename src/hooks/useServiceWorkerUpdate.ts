import { useCallback, useEffect, useRef, useState } from 'react';
import { waitForCurrentLocalCommits } from '../lib/localCommitTracker';
import { prepareServiceWorkerUpdate } from '../lib/serviceWorkerUpdatePolicy';

type UseServiceWorkerUpdateOptions = {
  flushCurrentProgress?: () => Promise<boolean>;
  onPersistenceError?: (message: string) => void;
};

export const useServiceWorkerUpdate = ({
  flushCurrentProgress,
  onPersistenceError,
}: UseServiceWorkerUpdateOptions = {}) => {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const applyingRef = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // Next dev reuses chunk URLs while HMR changes their module graph. An
    // installed offline shell can combine old chunks with the new graph.
    if (process.env.NODE_ENV === 'development'
      && process.env.NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER !== '1') {
      let active = true;
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        const appRegistrations = registrations.filter((registration) => (
          [registration.active, registration.waiting, registration.installing]
            .some((worker) => worker && new URL(worker.scriptURL).pathname === '/sw.js')
        ));
        await Promise.all(appRegistrations.map((registration) => registration.unregister()));
        const controller = navigator.serviceWorker.controller;
        if (active && controller && new URL(controller.scriptURL).pathname === '/sw.js') {
          window.location.reload();
        }
      }).catch((error) => console.warn('[PWA] Development worker cleanup failed:', error));
      return () => { active = false; };
    }
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

    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((nextRegistration) => {
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
    if (!waitingWorker || applyingRef.current) return false;
    applyingRef.current = true;
    setIsApplying(true);
    let activating = false;
    try {
      const ready = await prepareServiceWorkerUpdate({
        flushCurrentProgress,
        drainLocalCommits: waitForCurrentLocalCommits,
      });
      if (!ready) {
        onPersistenceError?.('저장 작업 중 오류가 발생해 업데이트 적용을 중단했습니다. 다시 시도해 주세요.');
        return false;
      }
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      activating = true;
      return true;
    } catch {
      onPersistenceError?.('업데이트를 적용하지 못했습니다. 다시 시도해 주세요.');
      return false;
    } finally {
      if (!activating) {
        applyingRef.current = false;
        setIsApplying(false);
      }
    }
  }, [flushCurrentProgress, onPersistenceError, waitingWorker]);

  return { updateAvailable: Boolean(waitingWorker), isApplying, applyUpdate };
};
