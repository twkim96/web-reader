import { hasPublishedBoundaryClockRisk, type PublishedReadingCalendar } from './readingRollupCalendar';
import {
  isReadingSessionV1, READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS, READING_SESSION_MAX_CLOCK_OFFSET_MS,
  READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES, type ReadingSessionV1,
} from './readingStatistics';
import { parseReadingReportBooks, type ReadingReportBook } from './readingStatisticsReport';
import { parseReadingFileRollups, readingRollupWeekForDay, type ReadingFileRollup } from './readingStatisticsRollup';

export type ReadingUploadTime = { seconds: number; nanoseconds: number };
export type ReadingRollupArchive = {
  calendar: PublishedReadingCalendar;
  files: ReadingFileRollup[];
  books: ReadingReportBook[];
  sourceThrough: ReadingUploadTime;
};
export type ReadingRollupBootstrap = ReadingRollupArchive & { carry: { sampleFloor: number; sessions: ReadingSessionV1[] } };
export type ReadingRollupCheckpoint = {
  firstDay: string;
  lastDay: string;
  sourceThrough: ReadingUploadTime;
  sampleFloor: number;
  checkedAt: number;
};

export function isReadingUploadTime(value: unknown): value is ReadingUploadTime {
  if (!value || typeof value !== 'object') return false;
  const stamp = value as Partial<ReadingUploadTime>;
  return typeof stamp.seconds === 'number' && Number.isSafeInteger(stamp.seconds) && stamp.seconds > 0 && stamp.seconds <= 253_402_300_799
    && typeof stamp.nanoseconds === 'number' && Number.isInteger(stamp.nanoseconds) && stamp.nanoseconds >= 0 && stamp.nanoseconds < 1_000_000_000;
}

export const compareReadingUploadTimes = (a: ReadingUploadTime, b: ReadingUploadTime) => a.seconds - b.seconds || a.nanoseconds - b.nanoseconds;

export function readReadingRollupCheckpoint(value: unknown): ReadingRollupCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as ReadingRollupCheckpoint;
  if (typeof point.firstDay !== 'string' || typeof point.lastDay !== 'string' || point.lastDay < point.firstDay
    || readingRollupWeekForDay(point.firstDay) !== point.firstDay || !readingRollupWeekForDay(point.lastDay)
    || !isReadingUploadTime(point.sourceThrough) || !Number.isSafeInteger(point.sampleFloor) || !Number.isSafeInteger(point.checkedAt)) return null;
  return point;
}

export function parseReadingRollupArchive(value: unknown): ReadingRollupArchive | null {
  if (!value || typeof value !== 'object') return null;
  const { calendar, files, books, sourceThrough } = value as ReadingRollupArchive;
  if (!calendar || !readReadingRollupCheckpoint({ ...calendar, sourceThrough, sampleFloor: 0, checkedAt: 0 })
    || !Array.isArray(calendar.days) || !parseReadingFileRollups(files) || !parseReadingReportBooks(books)) return null;
  const dates = new Set<string>();
  let screenMs = 0, ttsMs = 0;
  for (const row of calendar.days) {
    if (!row || !readingRollupWeekForDay(row.localDate) || dates.has(row.localDate)
      || row.localDate < calendar.firstDay || row.localDate > calendar.lastDay
      || ![row.screenMs, row.ttsMs].every((ms) => Number.isSafeInteger(ms) && ms >= 0)
      || row.totalMs !== row.screenMs + row.ttsMs) return null;
    dates.add(row.localDate);
    screenMs += row.screenMs;
    ttsMs += row.ttsMs;
  }
  if (!Number.isSafeInteger(screenMs) || !Number.isSafeInteger(ttsMs)
    || books.reduce((sum, row) => sum + row.screenMs, 0) !== screenMs || books.reduce((sum, row) => sum + row.ttsMs, 0) !== ttsMs) return null;
  return { calendar, files, books, sourceThrough };
}

export function parseReadingRollupBootstrap(value: unknown): ReadingRollupBootstrap | null {
  const archive = parseReadingRollupArchive(value);
  const carry = (value as ReadingRollupBootstrap | null | undefined)?.carry;
  if (!archive || !carry || !Number.isSafeInteger(carry.sampleFloor) || !Array.isArray(carry.sessions)
    || !carry.sessions.every(isReadingSessionV1) || new Set(carry.sessions.map(({ sessionId }) => sessionId)).size !== carry.sessions.length
    || hasPublishedBoundaryClockRisk(carry.sessions, archive.calendar)) return null;
  return { ...archive, carry };
}

/** The session is covered and cannot affect any open-day activity or clock correction. */
export function isReadingSessionCoveredByPublication(point: ReadingRollupCheckpoint, session: ReadingSessionV1) {
  if ((session.clockMeasuredAtClient ?? -Infinity) >= point.sampleFloor) return false;
  const firstDay = Date.parse(point.firstDay);
  const openDay = Date.parse(point.lastDay) + 86_400_000;
  const earliestLocalStart = session.startedAtClient - session.timezoneOffsetMinutes * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS;
  // Overlap is resolved in absolute time, including across different device timezones.
  const earliestOpenStart = openDay - READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES * 60_000;
  return earliestLocalStart >= firstDay && session.endedAtClient + READING_SESSION_MAX_CLOCK_OFFSET_MS <= earliestOpenStart;
}

/** A tail upload must not move a finalized date or need pre-carry calibration. */
export function readingRollupTailIsSafe(
  point: ReadingRollupCheckpoint,
  current: readonly ReadingSessionV1[],
  incoming: readonly ReadingSessionV1[],
) {
  const openDay = Date.parse(point.lastDay) + 86_400_000;
  return incoming.every((session) => session.completionRoundNumber !== undefined || (
    session.startedAtClient - session.timezoneOffsetMinutes * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS >= openDay
    && session.startedAtClient - READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS >= point.sampleFloor
  )) && !hasPublishedBoundaryClockRisk([...current, ...incoming], point);
}
