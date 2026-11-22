import { useCallback, useEffect, useRef, useState } from 'react';
import { waitForCurrentLocalCommits } from '../lib/localCommitTracker';
import { activateWaitingServiceWorker, prepareServiceWorkerUpdate } from '../lib/serviceWorkerUpdatePolicy';

type UseServiceWorkerUpdateOptions = {
  flushCurrentProgress?: () => Promise<boolean>;
  onPersistenceError?: (message: string) => void;
};

type UpdateSource = {
  registration: ServiceWorkerRegistration | null;
  loadedController: ServiceWorker | null;
};

export const useServiceWorkerUpdate = ({
  flushCurrentProgress,
  onPersistenceError,
}: UseServiceWorkerUpdateOptions = {}) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const applyingRef = useRef(false);
  const updateSourceRef = useRef<UpdateSource | null>(null);

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
    const { serviceWorker } = navigator;
    const source: UpdateSource = { registration: null, loadedController: serviceWorker.controller };
    updateSourceRef.current = source;
    let observedWorker: ServiceWorker | null = null;

    const inspectUpdate = () => {
      const { controller } = serviceWorker;
      source.loadedController ??= controller;
      setUpdateAvailable(Boolean(controller && (
        controller !== source.loadedController || source.registration?.waiting?.state === 'installed'
      )));
      const worker = source.registration?.installing ?? source.registration?.waiting ?? null;
      if (worker === observedWorker) return;
      observedWorker?.removeEventListener('statechange', inspectUpdate);
      observedWorker = worker;
      observedWorker?.addEventListener('statechange', inspectUpdate);
    };
    serviceWorker.addEventListener('controllerchange', inspectUpdate);
    void serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((registration) => {
      if (updateSourceRef.current !== source) return;
      source.registration = registration;
      registration.addEventListener('updatefound', inspectUpdate);
      inspectUpdate();
    }).catch(() => undefined);
    return () => {
      updateSourceRef.current = null;
      observedWorker?.removeEventListener('statechange', inspectUpdate);
      source.registration?.removeEventListener('updatefound', inspectUpdate);
      serviceWorker.removeEventListener('controllerchange', inspectUpdate);
    };
  }, []);

  const applyUpdate = useCallback(async () => {
    const source = updateSourceRef.current;
    if (!source || !updateAvailable || applyingRef.current) return false;
    applyingRef.current = true;
    setIsApplying(true);
    try {
      const ready = await prepareServiceWorkerUpdate({
        flushCurrentProgress,
        drainLocalCommits: waitForCurrentLocalCommits,
      });
      if (updateSourceRef.current !== source) return false;
      if (!ready) {
        onPersistenceError?.('저장 작업 중 오류가 발생해 업데이트 적용을 중단했습니다. 다시 시도해 주세요.');
        return false;
      }
      const { serviceWorker } = navigator;
      const { controller } = serviceWorker;
      // Another tab may already have activated the update, including while
      // this tab was still saving. Only reload after our own saves complete.
      if (!controller || controller === source.loadedController) {
        const worker = source.registration?.waiting;
        if (worker?.state !== 'installed') throw new Error('No service worker is waiting.');
        await activateWaitingServiceWorker(serviceWorker, worker);
      }
      if (updateSourceRef.current !== source) return false;
      window.location.reload();
      return true;
    } catch {
      onPersistenceError?.('업데이트를 적용하지 못했습니다. 다시 시도해 주세요.');
      return false;
    } finally {
      applyingRef.current = false;
      setIsApplying(false);
    }
  }, [flushCurrentProgress, onPersistenceError, updateAvailable]);

  return { updateAvailable, isApplying, applyUpdate };
};
