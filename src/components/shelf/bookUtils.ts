import { Book, UserProgress } from '../../types';
import { getBookTitleFromFileName } from '../../lib/bookFormats';

export type ShelfSortMode = 'alpha' | 'recent';
export type ShelfViewMode = 'grid' | 'list';
export type ShelfTheme = {
  bg: string;
  text: string;
  border: string;
  secondary: string;
};

export const getDisplayBookTitle = (name: string) => (
  getBookTitleFromFileName(name)
);

export const normalizeBookSearchText = (value: string) => (
  getDisplayBookTitle(value).replace(/\s+/g, '').toLowerCase()
);

export const getProgressTime = (timestamp: unknown) => {
  if (!timestamp) return 0;
  const value = timestamp as { toDate?: () => Date };
  const date = value.toDate ? value.toDate() : new Date(timestamp as string | number | Date);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
};

export const isReadingProgress = (progressPercent = 0) => {
  const displayedPercent = Number(progressPercent.toFixed(1));
  return displayedPercent > 0 && displayedPercent < 100;
};

export const filterAndSortBooks = (
  books: Book[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
  progress: Record<string, UserProgress>
) => {
  const normalizedKeyword = normalizeBookSearchText(searchKeyword);

  return books
    .filter(book => {
      if (!book.name) return false;
      if (!normalizedKeyword) return true;
      return normalizeBookSearchText(book.name).includes(normalizedKeyword);
    })
    .sort((a, b) => {
      const isReadA = isReadingProgress(progress[a.id]?.progressPercent || 0);
      const isReadB = isReadingProgress(progress[b.id]?.progressPercent || 0);

      if (isReadA !== isReadB) return isReadA ? -1 : 1;

      if (sortMode === 'alpha') {
        return getDisplayBookTitle(a.name).localeCompare(getDisplayBookTitle(b.name), 'ko-KR');
      }

      const pA = isReadA ? getProgressTime(progress[a.id]?.lastRead) : 0;
      const pB = isReadB ? getProgressTime(progress[b.id]?.lastRead) : 0;
      if (pA === 0 && pB === 0) return books.indexOf(a) - books.indexOf(b);
      return pB - pA;
    });
};
