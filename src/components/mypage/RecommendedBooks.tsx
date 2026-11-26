'use client';

import { useDeferredValue, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DiscoveryBook } from '../../lib/bookDiscovery';
import { recommendDiscoveryBooks } from '../../lib/bookRecommendations';
import type { ReadBook } from '../../lib/readBooks';
import { DashboardBookRow } from './DashboardBookRow';

export function createRecommendationRanker(catalog: readonly DiscoveryBook[], rotationSeed: number) {
  let last: { key: string; books: readonly DiscoveryBook[] } | undefined;
  return (wishlist: readonly DiscoveryBook[], readBooks: readonly ReadBook[]) => {
    // The catalog supplies scoring fields. Ordered identities select the seeds,
    // and identities outside the seed window still affect exclusions.
    const key = JSON.stringify([
      wishlist.map(({ id, platforms }) => [id, platforms.map(({ id, url }) => [id, url])]),
      readBooks.map(({ id, equivalentTitleKeys, platformWorkKeys }) => [id, equivalentTitleKeys ?? [], platformWorkKeys ?? []]),
    ]);
    if (last?.key !== key) last = { key, books: recommendDiscoveryBooks(catalog, wishlist, readBooks, rotationSeed) };
    return last.books;
  };
}

export function RecommendedBooks({ rank, wishlist, readBooks, previousBooks, keepPrevious, onRemember, onOpenBook, onShowAll, renderList }: {
  rank: ReturnType<typeof createRecommendationRanker>;
  wishlist?: readonly DiscoveryBook[];
  readBooks: readonly ReadBook[] | null;
  previousBooks?: readonly DiscoveryBook[];
  keepPrevious: boolean;
  onRemember: (books: readonly DiscoveryBook[]) => void;
  onOpenBook: (book: DiscoveryBook) => void;
  onShowAll: () => void;
  renderList?: (books: readonly DiscoveryBook[] | undefined) => ReactNode;
}) {
  const readyRank = useDeferredValue(rank, null);
  const ranked = useMemo(() => !keepPrevious && readyRank === rank && wishlist && readBooks
    ? rank(wishlist, readBooks) : undefined, [keepPrevious, rank, readyRank, wishlist, readBooks]);
  useEffect(() => {
    if (ranked && ranked !== previousBooks) onRemember(ranked);
  }, [ranked, previousBooks, onRemember]);

  const books = wishlist ? ranked ?? previousBooks : undefined;
  if (renderList) return renderList(books);
  if (!books?.length) return null;

  return <DashboardBookRow title="추천 도서" books={books} onOpenBook={onOpenBook} onShowAll={onShowAll}
    coverLoading="direct-with-proxy-fallback" />;
}
