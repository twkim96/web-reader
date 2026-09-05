'use client';

import { MutableRefObject, useCallback, useEffect, useRef } from 'react';
import { FoliateViewElement, SearchResultPayload } from './types';

interface UseFoliateSearchOptions {
  viewRef: MutableRefObject<FoliateViewElement | null>;
}

export const useFoliateSearch = ({ viewRef }: UseFoliateSearchOptions) => {
  const activeSearch = useRef<AbortController | null>(null);
  useEffect(() => () => activeSearch.current?.abort(), []);

  const searchBook = useCallback(async (
    query: string,
    onResult: (result: SearchResultPayload) => void,
    onProgress: (progress: number) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    activeSearch.current?.abort();
    const controller = new AbortController();
    activeSearch.current = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const view = viewRef.current;
    const isCurrent = () => !controller.signal.aborted && viewRef.current === view;

    try {
      if (!view || !query.trim() || !isCurrent()) return;
      const total = view.book?.sections?.length || 1;
      let lastProgress = 0;
      const iter = view.search({ query, signal: controller.signal });

      for await (const result of iter) {
        if (!isCurrent() || result === 'done') break;

        if (typeof result?.progress === 'number') {
          lastProgress = result.progress;
          onProgress(result.progress);
        } else if (result?.subitems?.length) {
          onResult({
            label: result.label || '',
            index: result.index || 0,
            total,
            progress: lastProgress,
            subitems: result.subitems,
          });
        }
      }
    } catch (error) {
      if (isCurrent()) console.error('[Search] failed:', error);
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (activeSearch.current === controller) activeSearch.current = null;
    }
  }, [viewRef]);

  const clearSearch = useCallback(() => {
    activeSearch.current?.abort();
    activeSearch.current = null;
    viewRef.current?.clearSearch?.();
  }, [viewRef]);

  return { searchBook, clearSearch };
};
