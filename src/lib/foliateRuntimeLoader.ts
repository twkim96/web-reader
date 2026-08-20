'use client';

import {
  clearStaleFoliateRuntimeEntries,
  createRetryablePreparation,
  FOLIATE_ENTRY_URL,
} from './foliateRuntimeCache.ts';

const prepareFoliateRuntime = createRetryablePreparation(async () => {
  if (!('caches' in window)) return;
  await clearStaleFoliateRuntimeEntries(window.caches, window.location.origin);
});

const registerFoliateView = createRetryablePreparation(async () => {
  await prepareFoliateRuntime();
  if (customElements.get('foliate-view')) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = FOLIATE_ENTRY_URL;
    let check = 0;
    let timeout = 0;
    const cleanup = () => {
      window.clearInterval(check);
      window.clearTimeout(timeout);
    };
    script.onload = () => undefined;
    script.onerror = (event) => {
      cleanup();
      console.error('[Foliate] view.js load error:', event);
      reject(event);
    };
    document.head.appendChild(script);

    check = window.setInterval(() => {
      if (!customElements.get('foliate-view')) return;
      cleanup();
      resolve();
    }, 100);

    timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('foliate-view 등록 시간이 초과되었습니다.'));
    }, 10_000);
  });
});

export const waitForFoliateViewRegistration = () => registerFoliateView();
