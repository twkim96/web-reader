import { useMemo } from 'react';
import { Book, UserProgress } from '../../types';
import { filterAndSortBooks, ShelfSortMode } from './bookUtils';

export const useFilteredBooks = (
  books: Book[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
  progress: Record<string, UserProgress>
) => (
  useMemo(
    () => filterAndSortBooks(books, searchKeyword, sortMode, progress),
    [books, searchKeyword, sortMode, progress]
  )
);
