'use client';

import {
  createRetryablePreparation,
  FOLIATE_ENTRY_URL,
} from './foliateRuntimeCache.ts';

const registerFoliateView = createRetryablePreparation(async () => {
  // Only SW activation may retire a cache: an older worker can still control this page.
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
