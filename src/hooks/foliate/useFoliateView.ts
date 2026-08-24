'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getProgressFromRelocateDetail } from './progress';
import { installScrollBoundaryNavigation } from './scrollBoundaryNavigation';
import { FoliateViewElement, RelocateDetail } from './types';
import { waitForFoliateViewRegistration } from '../../lib/foliateRuntimeLoader';

interface UseFoliateViewOptions {
  onRelocate?: (detail: RelocateDetail) => void;
  onLoad?: (doc?: Document, index?: number) => void;
  onCfiChange: (cfi: string) => void;
  onAnchorCfiChange: (cfi: string) => void;
  onProgressChange: (progressPercent: number) => void;
  onChapterChange: (chapter: string) => void;
}

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

    view.addEventListener('load', ((event: CustomEvent<{ doc?: Document; index?: number }>) => {
      const { doc, index } = event.detail || {};
      onLoad?.(doc, index);
      if (doc) {
        installScrollBoundaryNavigation(viewRef, doc);
      }
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
