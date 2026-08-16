import { useMemo } from 'react';
import { Book, UserProgress } from '../../types';
import {
  applyShelfProgress,
  applyShelfCatalog,
  EMPTY_SHELF_FILTERS,
  filterAndSortPreparedBooks,
  prepareShelfBooks,
  PreparedShelfBook,
  ShelfSortMode,
  type ShelfFilters,
} from './bookUtils';
import type { PublicBookCatalogBook } from '../../lib/publicBookCatalogSchema';

export const usePreparedShelfBooks = (
  books: Book[],
  progress: Record<string, UserProgress>,
  catalogByBookId: ReadonlyMap<string, PublicBookCatalogBook> = new Map(),
) => {
  const staticBooks = useMemo(() => prepareShelfBooks(books), [books]);
  const prepared = useMemo(
    () => applyShelfProgress(staticBooks, progress),
    [staticBooks, progress],
  );
  return useMemo(
    () => applyShelfCatalog(prepared, catalogByBookId),
    [catalogByBookId, prepared],
  );
};

export const useFilteredBooks = (
  books: PreparedShelfBook[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
  priorityBookIds: string[] = [],
  filters: ShelfFilters = EMPTY_SHELF_FILTERS,
) => (
  useMemo(
    () => filterAndSortPreparedBooks(
      books,
      searchKeyword,
      sortMode,
      priorityBookIds,
      filters,
    ),
    [books, filters, priorityBookIds, searchKeyword, sortMode],
  )
);
