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
      activating = true;
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      return true;
    } finally {
      if (!activating) applyingRef.current = false;
    }
  }, [flushCurrentProgress, onPersistenceError, waitingWorker]);

  return { updateAvailable: Boolean(waitingWorker), applyUpdate };
};
