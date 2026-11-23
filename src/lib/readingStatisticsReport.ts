import {
  buildReadingStatistics,
  isLocalDateWithinBounds,
  MIN_READING_STATISTICS_BLOCK_MS,
  type ReadingDayStatistics,
  type ReadingSessionV1,
} from './readingStatistics';

export type ReadingReportRange = { firstDay: string; lastDay: string };
export type ReadingReportBook = {
  bookId: string;
  bookTitle: string;
  lastReadAt: number;
  screenMs: number;
  ttsMs: number;
};

export type PublishedReadingReportBooks = ReadingReportRange & { books: ReadingReportBook[] };
type DateBounds = Parameters<typeof isLocalDateWithinBounds>[1];
type TimedBook = Pick<ReadingSessionV1, 'bookId' | 'bookTitle' | 'mode'> & { startAt: number; durationMs: number };

function addBook(books: Map<string, ReadingReportBook>, book: ReadingReportBook) {
  const previous = books.get(book.bookId);
  if (!previous) {
    books.set(book.bookId, { ...book });
    return;
  }
  previous.screenMs += book.screenMs;
  previous.ttsMs += book.ttsMs;
  if (book.lastReadAt > previous.lastReadAt
    || (book.lastReadAt === previous.lastReadAt && book.bookTitle < previous.bookTitle)) {
    previous.bookTitle = book.bookTitle;
    previous.lastReadAt = book.lastReadAt;
  }
}

function addTimedBook(books: Map<string, ReadingReportBook>, { bookId, bookTitle, mode, startAt, durationMs }: TimedBook) {
  addBook(books, {
    bookId, bookTitle, lastReadAt: startAt,
    screenMs: mode === 'screen' ? durationMs : 0,
    ttsMs: mode === 'tts' ? durationMs : 0,
  });
}

export function summarizeReadingReportBooks(activities: Iterable<TimedBook>) {
  const books = new Map<string, ReadingReportBook>();
  for (const activity of activities) addTimedBook(books, activity);
  return [...books.values()];
}

export function mergeReadingReportBooks(...sources: readonly (readonly ReadingReportBook[])[]) {
  const books = new Map<string, ReadingReportBook>();
  for (const source of sources) for (const book of source) addBook(books, book);
  return [...books.values()].sort((a, b) => b.lastReadAt - a.lastReadAt || a.bookId.localeCompare(b.bookId));
}

export function parseReadingReportBooks(value: unknown): ReadingReportBook[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const book of value) {
    if (!book || typeof book.bookId !== 'string' || !book.bookId || ids.has(book.bookId)
      || typeof book.bookTitle !== 'string'
      || ![book.lastReadAt, book.screenMs, book.ttsMs].every((ms) => Number.isSafeInteger(ms) && ms >= 0)
      || book.screenMs + book.ttsMs <= 0) return null;
    ids.add(book.bookId);
  }
  return value.map(({ bookId, bookTitle, lastReadAt, screenMs, ttsMs }) => ({
    bookId, bookTitle, lastReadAt, screenMs, ttsMs,
  }));
}

export function prepareLocalReadingReport(sessions: readonly ReadingSessionV1[]) {
  const booksByDay = new Map<string, Map<string, ReadingReportBook>>();
  const { days } = buildReadingStatistics(sessions, {}, ({ session, localDate, startAt, durationMs }) => {
    let books = booksByDay.get(localDate);
    if (!books) {
      books = new Map();
      booksByDay.set(localDate, books);
    }
    const { bookId, bookTitle, mode } = session;
    addTimedBook(books, { bookId, bookTitle, mode, startAt, durationMs });
  }, { minimumMs: MIN_READING_STATISTICS_BLOCK_MS });
  return {
    days,
    books(bounds: DateBounds, archived: PublishedReadingReportBooks | null = null) {
      const books = new Map<string, ReadingReportBook>();
      for (const book of archived?.books ?? []) addBook(books, book);
      for (const [localDate, rows] of booksByDay) {
        if (!isLocalDateWithinBounds(localDate, bounds)) continue;
        if (archived && localDate >= archived.firstDay && localDate <= archived.lastDay) continue;
        for (const book of rows.values()) addBook(books, book);
      }
      return [...books.values()].sort((a, b) => b.lastReadAt - a.lastReadAt || a.bookId.localeCompare(b.bookId));
    },
  };
}

export function sumReadingReportDays(days: readonly ReadingDayStatistics[], bounds: DateBounds = {}) {
  const totals = { totalMs: 0, screenMs: 0, ttsMs: 0 };
  for (const day of days) {
    if (!isLocalDateWithinBounds(day.localDate, bounds)) continue;
    totals.totalMs += day.totalMs;
    totals.screenMs += day.screenMs;
    totals.ttsMs += day.ttsMs;
  }
  return totals;
}
