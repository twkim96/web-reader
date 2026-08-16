import { useEffect, useState } from 'react';
import type { Book } from '../types';
import {
  joinBooksToPublicCatalog,
  loadPublicBookCatalog,
  type PublicBookCatalogBook,
  type PublicBookCatalogSnapshot,
} from '../lib/publicBookCatalog';

export type PublicBookCatalogLoadState = 'loading' | 'ready' | 'error';

export const usePublicBookCatalog = (books: readonly Book[]) => {
  const [snapshot, setSnapshot] = useState<PublicBookCatalogSnapshot | null>(null);
  const [booksById, setBooksById] = useState<Map<string, PublicBookCatalogBook>>(
    () => new Map(),
  );
  const [state, setState] = useState<PublicBookCatalogLoadState>('loading');
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let active = true;
    void loadPublicBookCatalog().then((nextSnapshot) => {
      if (!active) return;
      setSnapshot(nextSnapshot);
    }).catch((error) => {
      console.error('[PublicBookCatalog] load failed:', error);
      if (active) setState('error');
    });
    return () => { active = false; };
  }, [retryNonce]);

  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    void joinBooksToPublicCatalog(books, snapshot).then((joined) => {
      if (!active) return;
      setBooksById(joined);
      setState('ready');
    }).catch((error) => {
      console.error('[PublicBookCatalog] alias join failed:', error);
      if (active) setState('error');
    });
    return () => { active = false; };
  }, [books, retryNonce, snapshot]);

  return {
    snapshot,
    booksById,
    state,
    retry: () => {
      setState('loading');
      setRetryNonce((current) => current + 1);
    },
  };
};
