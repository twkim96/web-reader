import {
  buildReadingStatistics,
  getReadingSessionLocalDate,
  MIN_READING_STATISTICS_BLOCK_MS,
  type ReadingActivityBlock,
  type ReadingDayStatistics,
  type ReadingSessionV1,
} from './readingStatistics';

type ReadingRollupActivity = Omit<ReadingActivityBlock, 'session'> & Pick<
  ReadingSessionV1,
  'bookId' | 'bookTitle' | 'mode' | 'timezoneOffsetMinutes'
>;

type ProgressInterval = [startPercent: number, endPercent: number];

type ReadingFileRollup = {
  fileId: string;
  titles: string[];
  lastReadAt: number;
  filteredMs: number;
  unfilteredMs: number;
  progressIntervals: ProgressInterval[];
  absoluteMaxProgressPercent: number;
};

export type WeeklyReadingRollup = {
  weekStart: string;
  days: ReadingDayStatistics[];
  activities: ReadingRollupActivity[];
  files: ReadingFileRollup[];
};

export type ReadingCalendarRollup = {
  weekStarts: string[];
  days: ReadingDayStatistics[];
};

const DAY_MS = 86_400_000;
const CALENDAR_WEEK_COUNT = 10;
const WEEK_MS = 7 * DAY_MS;

export function parseReadingRollupMonday(weekStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new RangeError('weekStart must be a Monday in YYYY-MM-DD format');
  }
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (date.getUTCDay() !== 1 || getReadingSessionLocalDate(date.getTime(), 0) !== weekStart) {
    throw new RangeError('weekStart must be a Monday in YYYY-MM-DD format');
  }
  return date.getTime();
}

function unionProgressIntervals(intervals: ProgressInterval[]): ProgressInterval[] {
  const union: ProgressInterval[] = [];
  for (const [start, end] of intervals.sort(([left], [right]) => left - right)) {
    const previous = union.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else union.push([start, end]);
  }
  return union;
}

export function computeWeeklyReadingRollup(
  sessions: readonly ReadingSessionV1[],
  weekStart: string,
): WeeklyReadingRollup {
  const bounds = {
    startLocalDate: weekStart,
    endLocalDate: getReadingSessionLocalDate(parseReadingRollupMonday(weekStart) + 6 * DAY_MS, 0),
  };
  const activities: ReadingRollupActivity[] = [];
  const filtered = buildReadingStatistics(sessions, bounds, undefined, {
    minimumMs: MIN_READING_STATISTICS_BLOCK_MS,
    onBlock: ({ session, ...block }) => {
      const { bookId, bookTitle, mode, timezoneOffsetMinutes } = session;
      activities.push({ ...block, bookId, bookTitle, mode, timezoneOffsetMinutes });
    },
  });
  const filteredMs = new Map(filtered.books.map(({ bookId, totalMs }) => [bookId, totalMs]));
  const files = new Map<string, Omit<ReadingFileRollup, 'titles'> & { titles: Set<string> }>();
  buildReadingStatistics(sessions, bounds, ({ session, durationMs }) => {
    files.get(session.bookId)!.unfilteredMs += durationMs;
  }, undefined, (session, lastAt) => {
    const { bookId, bookTitle, completionRoundNumber, startProgressPercent, endProgressPercent } = session;
    if (completionRoundNumber !== undefined) return;
    const file = files.get(bookId) ?? {
      fileId: bookId,
      titles: new Set<string>(),
      lastReadAt: 0,
      filteredMs: filteredMs.get(bookId) ?? 0,
      unfilteredMs: 0,
      progressIntervals: [],
      absoluteMaxProgressPercent: 0,
    };
    const low = Math.min(startProgressPercent, endProgressPercent);
    const high = Math.max(startProgressPercent, endProgressPercent);
    file.lastReadAt = Math.max(file.lastReadAt, lastAt);
    file.titles.add(bookTitle);
    if (low !== high) file.progressIntervals.push([low, high]);
    file.absoluteMaxProgressPercent = Math.max(file.absoluteMaxProgressPercent, high);
    files.set(bookId, file);
  });

  return {
    weekStart,
    days: filtered.days,
    activities: activities.reverse().sort((left, right) => right.localDate.localeCompare(left.localDate)),
    files: [...files.values()].map((file) => ({
      ...file,
      titles: [...file.titles].sort(),
      progressIntervals: unionProgressIntervals(file.progressIntervals),
    })).sort((left, right) => left.fileId.localeCompare(right.fileId)),
  };
}

export function computeReadingCalendarRollup(weeks: readonly WeeklyReadingRollup[]): ReadingCalendarRollup {
  if (weeks.length !== CALENDAR_WEEK_COUNT) {
    throw new RangeError('Calendar rollup requires exactly 10 consecutive Mondays');
  }
  const ordered = Array.from(weeks, (week) => ({ week, monday: parseReadingRollupMonday(week?.weekStart) }))
    .sort((left, right) => right.monday - left.monday);
  if (ordered.some(({ monday }, index) => monday !== ordered[0].monday - index * WEEK_MS)) {
    throw new RangeError('Calendar rollup requires exactly 10 consecutive Mondays');
  }

  return {
    weekStarts: ordered.map(({ week }) => week.weekStart),
    days: ordered.flatMap(({ week }) => week.days),
  };
}
