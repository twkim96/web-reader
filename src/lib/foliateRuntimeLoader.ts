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
    const cleanup = () => {
      window.clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      script.remove();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('foliate-view 등록 시간이 초과되었습니다.'));
    }, 10_000);

    script.onload = () => {
      void customElements.whenDefined('foliate-view').then(() => {
        cleanup();
        resolve();
      });
    };
    script.onerror = (event) => {
      cleanup();
      console.error('[Foliate] view.js load error:', event);
      reject(event);
    };
    document.head.appendChild(script);
  });
});

export const waitForFoliateViewRegistration = () => registerFoliateView();
