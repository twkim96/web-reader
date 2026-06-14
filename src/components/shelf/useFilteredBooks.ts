import { useMemo } from 'react';
import { Book, UserProgress } from '../../types';
import {
  applyShelfProgress,
  filterAndSortPreparedBooks,
  prepareShelfBooks,
  PreparedShelfBook,
  ShelfSortMode,
} from './bookUtils';

export const usePreparedShelfBooks = (
  books: Book[],
  progress: Record<string, UserProgress>,
) => {
  const staticBooks = useMemo(() => prepareShelfBooks(books), [books]);
  return useMemo(
    () => applyShelfProgress(staticBooks, progress),
    [staticBooks, progress],
  );
};

export const useFilteredBooks = (
  books: PreparedShelfBook[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
) => (
  useMemo(
    () => filterAndSortPreparedBooks(books, searchKeyword, sortMode),
    [books, searchKeyword, sortMode],
  )
);
