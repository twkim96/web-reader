'use client';

import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ViewState } from '../types';

export function useMyPageNavigation({ view, setView, isLibraryBootstrapReady, autoOpenHandledRef }: {
  view: ViewState;
  setView: Dispatch<SetStateAction<ViewState>>;
  isLibraryBootstrapReady: boolean;
  autoOpenHandledRef: MutableRefObject<boolean>;
}) {
  const openMyPage = useCallback(() => {
    autoOpenHandledRef.current = true;
    window.history.pushState(null, '', '#mypage');
    setView('mypage');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [autoOpenHandledRef, setView]);
  const closeMyPage = useCallback(() => {
    window.history.pushState(null, '', window.location.pathname + window.location.search);
    setView('shelf');
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [setView]);
  useEffect(() => {
    // Wait for local hydration and leave the reader’s Back stack to the reader.
    if (!isLibraryBootstrapReady || view === 'loading' || view === 'reader') return;
    const update = () => {
      if (window.location.hash.startsWith('#mypage')) {
        autoOpenHandledRef.current = true;
        setView('mypage');
      } else setView(current => current === 'mypage' ? 'shelf' : current);
    };
    update();
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, [autoOpenHandledRef, isLibraryBootstrapReady, setView, view]);
  return { openMyPage, closeMyPage };
}
