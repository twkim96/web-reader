import type { ReadingDayStatistics } from './readingStatistics';
import { sumReadingReportDays, type ReadingReportBook } from './readingStatisticsReport';

export type ReadingStatisticsExportFile = {
  filename: string;
  mimeType: string;
  text: string;
};

const getDateStamp = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const createReadingStatisticsJsonExport = (
  days: readonly ReadingDayStatistics[],
  books: readonly ReadingReportBook[],
  generatedAt = Date.now(),
): ReadingStatisticsExportFile => ({
  filename: `web-reader-statistics-${getDateStamp(generatedAt)}.json`,
  mimeType: 'application/json;charset=utf-8',
  text: `${JSON.stringify({
    schemaVersion: 2,
    generatedAt,
    summary: {
      ...sumReadingReportDays(days),
      books: books.map((book) => ({ ...book, totalMs: book.screenMs + book.ttsMs })),
      days: [...days].sort((left, right) => right.localDate.localeCompare(left.localDate)),
    },
  }, null, 2)}\n`,
});
