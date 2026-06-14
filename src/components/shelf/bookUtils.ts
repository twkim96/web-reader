import type { Book, UserProgress } from '../../types.ts';
import { getBookTitleFromFileName } from '../../lib/bookFormats.ts';

export type ShelfSortMode = 'alpha' | 'recent';
export type ShelfViewMode = 'grid' | 'list';
export type ShelfTheme = {
  bg: string;
  text: string;
  border: string;
  secondary: string;
};
export type PreparedShelfBook = {
  book: Book;
  displayTitle: string;
  isReading: boolean;
  lastReadTime: number;
  normalizedTitle: string;
  originalIndex: number;
};

type StaticShelfBook = Omit<PreparedShelfBook, 'isReading' | 'lastReadTime'>;

const titleCollator = new Intl.Collator('ko-KR');

export const getDisplayBookTitle = (name: string) => (
  getBookTitleFromFileName(name)
);

export const getBookFormatLabel = (book: Pick<Book, 'name' | 'mimeType' | 'sourceFormat'>) => {
  const format = book.sourceFormat;
  if (format === 'txt') return 'TXT';
  if (format === 'epub') return 'EPUB';
  if (format === 'pdf') return 'PDF';
  if (format === 'zip') return 'ZIP 이미지';
  if (format === 'cbz') return 'CBZ 이미지';
  if (format === '7z') return '7Z 이미지';
  return book.name.toLowerCase().endsWith('.txt') ? 'TXT' : 'EPUB';
};

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

export const prepareShelfBooks = (books: Book[]): StaticShelfBook[] => (
  books.flatMap((book, originalIndex) => {
    if (!book.name) return [];
    const displayTitle = getDisplayBookTitle(book.name);
    return [{
      book,
      displayTitle,
      normalizedTitle: displayTitle.replace(/\s+/g, '').toLowerCase(),
      originalIndex,
    }];
  })
);

export const applyShelfProgress = (
  books: StaticShelfBook[],
  progress: Record<string, UserProgress>,
): PreparedShelfBook[] => books.map((prepared) => {
  const bookProgress = progress[prepared.book.id];
  const isReading = isReadingProgress(bookProgress?.progressPercent || 0);
  return {
    ...prepared,
    isReading,
    lastReadTime: isReading ? getProgressTime(bookProgress?.lastRead) : 0,
  };
});

const compareStableOrder = (a: PreparedShelfBook, b: PreparedShelfBook) => (
  a.originalIndex - b.originalIndex || a.book.id.localeCompare(b.book.id)
);

export const filterAndSortPreparedBooks = (
  books: PreparedShelfBook[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
) => {
  const normalizedKeyword = normalizeBookSearchText(searchKeyword);

  return books
    .filter(({ normalizedTitle }) => (
      !normalizedKeyword || normalizedTitle.includes(normalizedKeyword)
    ))
    .sort((a, b) => {
      if (a.isReading !== b.isReading) return a.isReading ? -1 : 1;
      if (sortMode === 'alpha') {
        return titleCollator.compare(a.displayTitle, b.displayTitle)
          || compareStableOrder(a, b);
      }
      if (a.isReading && a.lastReadTime !== b.lastReadTime) {
        return b.lastReadTime - a.lastReadTime;
      }
      return compareStableOrder(a, b);
    })
    .map(({ book }) => book);
};

export const filterAndSortBooks = (
  books: Book[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
  progress: Record<string, UserProgress>
) => filterAndSortPreparedBooks(
  applyShelfProgress(prepareShelfBooks(books), progress),
  searchKeyword,
  sortMode,
);
