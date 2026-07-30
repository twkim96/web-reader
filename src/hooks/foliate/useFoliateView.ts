'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getProgressFromRelocateDetail } from './progress';
import { installScrollBoundaryNavigation } from './scrollBoundaryNavigation';
import { FoliateViewElement, RelocateDetail } from './types';
import {
  clearStaleFoliateRuntimeEntries,
  createRetryablePreparation,
  FOLIATE_ENTRY_URL,
} from '../../lib/foliateRuntimeCache';

interface UseFoliateViewOptions {
  onRelocate?: (detail: RelocateDetail) => void;
  onLoad?: (doc?: Document) => void;
  onCfiChange: (cfi: string) => void;
  onAnchorCfiChange: (cfi: string) => void;
  onProgressChange: (progressPercent: number) => void;
  onChapterChange: (chapter: string) => void;
}

const prepareFoliateRuntime = createRetryablePreparation(async () => {
  if (!('caches' in window)) return;
  await clearStaleFoliateRuntimeEntries(window.caches, window.location.origin);
});

const waitForFoliateViewRegistration = async () => {
  await prepareFoliateRuntime();
  if (customElements.get('foliate-view')) return;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = FOLIATE_ENTRY_URL;
    script.onload = () => undefined;
    script.onerror = (event) => {
      console.error('[EpubReader] view.js load error:', event);
      reject(event);
    };
    document.head.appendChild(script);

    const check = window.setInterval(() => {
      if (customElements.get('foliate-view')) {
        window.clearInterval(check);
        window.clearTimeout(timeout);
        resolve();
      }
    }, 100);

    const timeout = window.setTimeout(() => {
      window.clearInterval(check);
      console.warn('[EpubReader] Timeout waiting for foliate-view registration. Proceeding anyway.');
      resolve();
    }, 10000);
  });
};

export const useFoliateView = ({
  onRelocate,
  onLoad,
  onCfiChange,
  onAnchorCfiChange,
  onProgressChange,
  onChapterChange,
}: UseFoliateViewOptions) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<FoliateViewElement | null>(null);
  const [isReady, setIsReady] = useState(false);

  const initView = useCallback(async () => {
    if (!containerRef.current || viewRef.current) return;

    await waitForFoliateViewRegistration();

    const view = document.createElement('foliate-view') as FoliateViewElement;
    view.style.width = '100%';
    view.style.height = '100%';

    view.addEventListener('relocate', ((event: CustomEvent<RelocateDetail>) => {
      const detail = event.detail;
      if (!detail) return;

      onCfiChange(detail.cfi || '');
      onAnchorCfiChange(detail.anchorCfi || detail.cfi || '');

      const progressPercent = getProgressFromRelocateDetail(detail);
      const relocateDetail = progressPercent !== null
        ? { ...detail, progressPercent }
        : detail;

      if (progressPercent !== null) {
        onProgressChange(progressPercent);
      }

      if (detail.tocItem?.label) {
        onChapterChange(detail.tocItem.label);
      }

      onRelocate?.(relocateDetail);
    }) as EventListener);

    view.addEventListener('load', ((event: CustomEvent<{ doc?: Document }>) => {
      const { doc } = event.detail || {};
      if (doc) {
        installScrollBoundaryNavigation(viewRef, doc);
      }
      onLoad?.(doc);
    }) as EventListener);

    containerRef.current.appendChild(view);
    viewRef.current = view;
    setIsReady(true);
  }, [onAnchorCfiChange, onCfiChange, onChapterChange, onLoad, onProgressChange, onRelocate]);

  useEffect(() => {
    return () => {
      try {
        viewRef.current?.close?.();
        viewRef.current?.remove();
      } catch {
        // Ignore Foliate cleanup errors during unmount.
      }
      viewRef.current = null;
    };
  }, []);

  return {
    containerRef,
    viewRef,
    isReady,
    initView,
  };
};
