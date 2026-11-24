'use client';

import { useDeferredValue, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DiscoveryBook } from '../../lib/bookDiscovery';
import { recommendDiscoveryBooks } from '../../lib/bookRecommendations';
import type { ReadBook } from '../../lib/readBooks';
import { DashboardBookRow } from './DashboardBookRow';

export function RecommendedBooks({ catalog, wishlist, readBooks, rotationSeed, previousBooks, keepPrevious, onRemember, onOpenBook, onShowAll, renderList }: {
  catalog: readonly DiscoveryBook[];
  wishlist?: readonly DiscoveryBook[];
  readBooks: readonly ReadBook[] | null;
  rotationSeed: number;
  previousBooks?: readonly DiscoveryBook[];
  keepPrevious: boolean;
  onRemember: (books: readonly DiscoveryBook[]) => void;
  onOpenBook: (book: DiscoveryBook) => void;
  onShowAll: () => void;
  renderList?: (books: readonly DiscoveryBook[] | undefined) => ReactNode;
}) {
  const readyCatalog = useDeferredValue<readonly DiscoveryBook[] | null>(catalog, null);
  const ranked = useMemo(() => !keepPrevious && readyCatalog && wishlist && readBooks
    ? recommendDiscoveryBooks(readyCatalog, wishlist, readBooks, rotationSeed) : undefined,
  [keepPrevious, readyCatalog, wishlist, readBooks, rotationSeed]);
  useEffect(() => {
    if (ranked && ranked !== previousBooks) onRemember(ranked);
  }, [ranked, previousBooks, onRemember]);

  const books = wishlist ? ranked ?? previousBooks : undefined;
  if (renderList) return renderList(books);
  if (!books?.length) return null;

  return <DashboardBookRow title="추천 도서" books={books} onOpenBook={onOpenBook} onShowAll={onShowAll}
    coverLoading="direct-with-proxy-fallback" />;
}
