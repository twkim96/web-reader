'use client';

import { Dispatch, MutableRefObject, SetStateAction, useCallback } from 'react';
import { buildTocProgress } from './toc';
import { FoliateBook, FoliateViewElement, TocItem } from './types';
import { openFoliateBook } from './openFoliateBook';

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
  const openBook = useCallback(async (
    source: Blob | File | string | FoliateBook,
    initialCfi?: string,
    beforeInit?: (view: FoliateViewElement) => void | Promise<void>,
  ) => {
    if (!viewRef.current) {
      await initView();
    }

    const view = viewRef.current;
    if (!view) return;

    try {
      await openFoliateBook(view, source, initialCfi, beforeInit);
      setToc(buildTocProgress(view));
    } catch (error) {
      console.error('Failed to open epub:', error);
      throw error;
    }
  }, [initView, setToc, viewRef]);

  const goTo = useCallback(async (cfi: string) => {
    const view = viewRef.current;
    if (!view) return false;

    try {
      return (await view.goTo(cfi)) !== false;
    } catch (error) {
      console.error('Failed to navigate to CFI:', error);
      return false;
    }
  }, [viewRef]);

  const goToFraction = useCallback(async (fraction: number) => {
    const view = viewRef.current;
    if (!view) return false;

    try {
      return await view.goToFraction(fraction);
    } catch (error) {
      console.error('Failed to navigate to fraction:', error);
      return false;
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
