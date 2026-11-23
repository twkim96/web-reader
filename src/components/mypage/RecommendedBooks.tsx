'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import type { DiscoveryBook } from '../../lib/bookDiscovery';
import { recommendDiscoveryBooks } from '../../lib/bookRecommendations';
import type { ReadBook } from '../../lib/readBooks';
import { DashboardBookRow } from './DashboardBookRow';

export function RecommendedBooks({ catalog, wishlist, readBooks, onOpenBook }: {
  catalog: readonly DiscoveryBook[];
  wishlist?: readonly DiscoveryBook[];
  readBooks: readonly ReadBook[];
  onOpenBook: (book: DiscoveryBook) => void;
}) {
  const [rotationSeed] = useState(() => Math.floor(Math.random() * 0x1_0000_0000));
  const readyCatalog = useDeferredValue<readonly DiscoveryBook[] | null>(catalog, null);
  const books = useMemo(() => readyCatalog ? recommendDiscoveryBooks(readyCatalog, wishlist ?? [], readBooks, rotationSeed) : [],
    [readyCatalog, wishlist, readBooks, rotationSeed]);
  if (!books.length) return null;

  return <DashboardBookRow title="추천 도서" books={books} onOpenBook={onOpenBook}
    coverLoading="direct-with-proxy-fallback" />;
}
