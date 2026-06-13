'use client';

import { Dispatch, MutableRefObject, SetStateAction, useCallback } from 'react';
import { buildTocProgress } from './toc';
import { FoliateBook, FoliateViewElement, TocItem } from './types';

interface UseFoliateNavigationOptions {
  viewRef: MutableRefObject<FoliateViewElement | null>;
  initView: () => Promise<void>;
  setToc: Dispatch<SetStateAction<TocItem[]>>;
}

export const useFoliateNavigation = ({
  viewRef,
  initView,
  setToc,
}: UseFoliateNavigationOptions) => {
  const openBook = useCallback(async (source: Blob | File | string | FoliateBook, initialCfi?: string) => {
    if (!viewRef.current) {
      await initView();
    }

    const view = viewRef.current;
    if (!view) return;

    try {
      let fileSource = source;
      if (source instanceof Blob && !(source instanceof File)) {
        fileSource = new File([source], 'book.epub', { type: 'application/epub+zip' });
      }

      await view.open(fileSource);
      await view.init({ lastLocation: initialCfi || null });
      setToc(buildTocProgress(view));
    } catch (error) {
      console.error('Failed to open epub:', error);
      throw error;
    }
  }, [initView, setToc, viewRef]);

  const goTo = useCallback(async (cfi: string) => {
    const view = viewRef.current;
    if (!view) return;

    try {
      await view.goTo(cfi);
    } catch (error) {
      console.error('Failed to navigate to CFI:', error);
    }
  }, [viewRef]);

  const goToFraction = useCallback(async (fraction: number) => {
    const view = viewRef.current;
    if (!view) return;

    try {
      await view.goToFraction(fraction);
    } catch (error) {
      console.error('Failed to navigate to fraction:', error);
    }
  }, [viewRef]);

  const prev = useCallback((distance?: number) => {
    viewRef.current?.prev(distance);
  }, [viewRef]);

  const next = useCallback((distance?: number) => {
    viewRef.current?.next(distance);
  }, [viewRef]);

  return {
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
  };
};
