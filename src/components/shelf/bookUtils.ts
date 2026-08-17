import type { Book, UserProgress } from '../../types.ts';
import { getBookTitleFromFileName } from '../../lib/bookFormats.ts';
import type {
  PublicBookCatalogBook,
  PublicBookCatalogPlatformId,
} from '../../lib/publicBookCatalogSchema.ts';
import type { PublicBookMetadata } from '../../lib/publicBookMetadataSchema.ts';

export type ShelfSortMode = 'alpha' | 'recent' | 'popularity';
export type ShelfViewMode = 'grid' | 'list';
export type ShelfSourceFilter = PublicBookCatalogPlatformId | 'none';
export type ShelfFilters = {
  sources: ShelfSourceFilter[];
  genreIds: number[];
  tagIds: number[];
};
export const EMPTY_SHELF_FILTERS: ShelfFilters = {
  sources: [],
  genreIds: [],
  tagIds: [],
};

export const getVisibleBookInfoCatalogTags = (catalog?: PublicBookCatalogBook) => (
  catalog?.tags
    .filter((tag) => tag.label !== catalog.genreLabel)
    ?? []
);
export const canRequestPublicBookMetadata = (
  catalog: PublicBookCatalogBook | undefined,
  catalogState: 'idle' | 'loading' | 'ready' | 'error',
  metadata: PublicBookMetadata | null,
  metadataState: 'loading' | 'ready' | 'missing' | 'error',
) => {
  if (catalogState !== 'ready' || (metadataState !== 'ready' && metadataState !== 'missing')) return false;
  const hasSourceCount = Boolean(
    catalog?.record.sourceCounts.some((count) => count !== null)
    || metadata?.platforms.some((platform) => (
      platform.viewCount !== null || platform.downloadCount !== null
    )),
  );
  return !catalog?.genreLabel
    && getVisibleBookInfoCatalogTags(catalog).length === 0
    && !hasSourceCount;
};
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
  catalog?: PublicBookCatalogBook;
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

export const applyShelfCatalog = (
  books: PreparedShelfBook[],
  catalogByBookId: ReadonlyMap<string, PublicBookCatalogBook>,
): PreparedShelfBook[] => books.map((prepared) => ({
  ...prepared,
  catalog: catalogByBookId.get(prepared.book.id),
}));

const compareStableOrder = (a: PreparedShelfBook, b: PreparedShelfBook) => (
  a.originalIndex - b.originalIndex || a.book.id.localeCompare(b.book.id)
);

const sourceBits: Record<PublicBookCatalogPlatformId, number> = {
  series: 1,
  kakao: 2,
  novelpia: 4,
};

export const getActiveShelfFilterCount = (filters: ShelfFilters) => (
  filters.sources.length + filters.genreIds.length + filters.tagIds.length
);

export const getShelfFilterKey = (filters: ShelfFilters) => [
  [...filters.sources].sort().join(','),
  [...filters.genreIds].sort((a, b) => a - b).join(','),
  [...filters.tagIds].sort((a, b) => a - b).join(','),
].join('|');

export const matchesShelfFilters = (
  prepared: PreparedShelfBook,
  filters: ShelfFilters,
) => {
  const record = prepared.catalog?.record;
  if (filters.sources.length > 0) {
    const matchesSource = filters.sources.some((source) => (
      source === 'none'
        ? !record || record.platformMask === 0
        : Boolean(record && (record.platformMask & sourceBits[source]))
    ));
    if (!matchesSource) return false;
  }
  if (filters.genreIds.length > 0) {
    if (
      !record
      || record.canonicalGenreId === null
      || !filters.genreIds.includes(record.canonicalGenreId)
    ) return false;
  }
  if (filters.tagIds.length > 0) {
    if (!record || !filters.tagIds.every((tagId) => record.tagIds.includes(tagId))) {
      return false;
    }
  }
  return true;
};

const comparePopularity = (a: PreparedShelfBook, b: PreparedShelfBook) => {
  const aRecord = a.catalog?.record;
  const bRecord = b.catalog?.record;
  const aScore = aRecord?.popularityScore ?? null;
  const bScore = bRecord?.popularityScore ?? null;
  if (aScore === null && bScore === null) return compareStableOrder(a, b);
  if (aScore === null) return 1;
  if (bScore === null) return -1;
  if (aScore !== bScore) return bScore - aScore;
  const bestRank = (ranks: readonly (number | null)[] | undefined) => {
    const present = ranks?.flatMap((rank) => (rank === null ? [] : [rank])) ?? [];
    return present.length > 0 ? Math.max(...present) : -1;
  };
  const aBest = bestRank(aRecord?.sourceRanks);
  const bBest = bestRank(bRecord?.sourceRanks);
  if (aBest !== bBest) return bBest - aBest;
  const aPlatforms = aRecord ? aRecord.platformMask.toString(2).replaceAll('0', '').length : 0;
  const bPlatforms = bRecord ? bRecord.platformMask.toString(2).replaceAll('0', '').length : 0;
  if (aPlatforms !== bPlatforms) return bPlatforms - aPlatforms;
  return titleCollator.compare(a.displayTitle, b.displayTitle)
    || compareStableOrder(a, b);
};

export const filterAndSortPreparedBooks = (
  books: PreparedShelfBook[],
  searchKeyword: string,
  sortMode: ShelfSortMode,
  priorityBookIds: readonly string[] = [],
  filters: ShelfFilters = EMPTY_SHELF_FILTERS,
) => {
  const normalizedKeyword = normalizeBookSearchText(searchKeyword);
  const priorityRanks = new Map(priorityBookIds.map((bookId, index) => [bookId, index]));

  return books
    .filter((prepared) => (
      matchesShelfFilters(prepared, filters)
      && (!normalizedKeyword || prepared.normalizedTitle.includes(normalizedKeyword))
    ))
    .sort((a, b) => {
      if (sortMode !== 'popularity') {
        const aPriority = priorityRanks.get(a.book.id);
        const bPriority = priorityRanks.get(b.book.id);
        if (aPriority !== undefined || bPriority !== undefined) {
          if (aPriority === undefined) return 1;
          if (bPriority === undefined) return -1;
          if (aPriority !== bPriority) return aPriority - bPriority;
        }
        if (a.isReading !== b.isReading) return a.isReading ? -1 : 1;
      }
      if (sortMode === 'popularity') return comparePopularity(a, b);
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
  progress: Record<string, UserProgress>,
  priorityBookIds: readonly string[] = [],
  filters: ShelfFilters = EMPTY_SHELF_FILTERS,
) => filterAndSortPreparedBooks(
  applyShelfProgress(prepareShelfBooks(books), progress),
  searchKeyword,
  sortMode,
  priorityBookIds,
  filters,
);
