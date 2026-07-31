// src/hooks/useEpubReader.ts
'use client';

import { useCallback, useState } from 'react';
import { toClampedPercent } from './foliate/progress';
import { RelocateDetail, TocItem } from './foliate/types';
import { useFoliateLayout } from './foliate/useFoliateLayout';
import { useFoliateNavigation } from './foliate/useFoliateNavigation';
import { useFoliateSearch } from './foliate/useFoliateSearch';
import { useFoliateView } from './foliate/useFoliateView';

interface UseEpubReaderOptions {
  onRelocate?: (detail: RelocateDetail) => void;
  onLoad?: (doc?: Document, index?: number) => void;
  initialPercent?: number;
}

export const useEpubReader = (options?: UseEpubReaderOptions) => {
  const [totalProgress, setTotalProgress] = useState(() => toClampedPercent(options?.initialPercent) ?? 0);
  const [currentCfi, setCurrentCfi] = useState<string>('');
  const [currentAnchorCfi, setCurrentAnchorCfi] = useState<string>('');
  const [currentChapter, setCurrentChapter] = useState<string>('');
  const [toc, setToc] = useState<TocItem[]>([]);

  const handleRelocate = useCallback((detail: RelocateDetail) => {
    options?.onRelocate?.(detail);
  }, [options]);

  const handleLoad = useCallback((doc?: Document, index?: number) => {
    options?.onLoad?.(doc, index);
  }, [options]);

  const {
    containerRef,
    viewRef,
    isReady,
    initView,
  } = useFoliateView({
    onRelocate: handleRelocate,
    onLoad: handleLoad,
    onCfiChange: setCurrentCfi,
    onAnchorCfiChange: setCurrentAnchorCfi,
    onProgressChange: setTotalProgress,
    onChapterChange: setCurrentChapter,
  });

  const {
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
  } = useFoliateNavigation({
    viewRef,
    initView,
    setToc,
  });

  const {
    setStyle,
    setLayout,
  } = useFoliateLayout({ viewRef });

  const {
    searchBook,
    clearSearch,
  } = useFoliateSearch({ viewRef });

  return {
    containerRef,
    isReady,
    totalProgress,
    currentCfi,
    currentAnchorCfi,
    currentChapter,
    toc,
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
    setStyle,
    setLayout,
    searchBook,
    clearSearch,
    viewRef,
  };
};
