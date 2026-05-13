'use client';

import { MutableRefObject, useCallback } from 'react';
import { FoliateViewElement, SearchResultPayload } from './types';

interface UseFoliateSearchOptions {
  viewRef: MutableRefObject<FoliateViewElement | null>;
}

export const useFoliateSearch = ({ viewRef }: UseFoliateSearchOptions) => {
  const searchBook = useCallback(async (
    query: string,
    onResult: (result: SearchResultPayload) => void,
    onProgress: (progress: number) => void,
  ): Promise<void> => {
    const view = viewRef.current;
    if (!view || !query.trim()) return;

    try {
      const total = view.book?.sections?.length || 1;
      let lastProgress = 0;
      const iter = view.search({ query });

      for await (const result of iter) {
        if (result === 'done') break;

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
      console.error('[Search] failed:', error);
    }
  }, [viewRef]);

  const clearSearch = useCallback(() => {
    viewRef.current?.clearSearch?.();
  }, [viewRef]);

  return {
    searchBook,
    clearSearch,
  };
};
