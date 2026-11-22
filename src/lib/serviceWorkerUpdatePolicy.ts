import type { waitForCurrentLocalCommits } from './localCommitTracker';

type DrainResult = Awaited<ReturnType<typeof waitForCurrentLocalCommits>>;

export const prepareServiceWorkerUpdate = async ({
  flushCurrentProgress,
  drainLocalCommits,
}: {
  flushCurrentProgress?: () => Promise<boolean>;
  drainLocalCommits: () => Promise<DrainResult>;
}) => {
  if (flushCurrentProgress && !await flushCurrentProgress()) return false;
  return (await drainLocalCommits()).ok;
};

const ACTIVATION_TIMEOUT_MS = 15_000;

export const activateWaitingServiceWorker = (
  serviceWorker: ServiceWorkerContainer,
  worker: ServiceWorker,
) => new Promise<void>((resolve, reject) => {
  const previousController = serviceWorker.controller;
  const finish = (error?: unknown) => {
    clearTimeout(timeout);
    serviceWorker.removeEventListener('controllerchange', onChange);
    if (error === undefined) resolve();
    else reject(error);
  };
  const onChange = () => {
    if (serviceWorker.controller && serviceWorker.controller !== previousController) finish();
  };
  const timeout = setTimeout(() => finish(new Error('Service worker activation timed out.')), ACTIVATION_TIMEOUT_MS);
  serviceWorker.addEventListener('controllerchange', onChange);
  try {
    worker.postMessage({ type: 'SKIP_WAITING' });
  } catch (error) {
    finish(error);
  }
});
