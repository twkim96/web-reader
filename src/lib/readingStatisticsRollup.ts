import {
  buildReadingStatistics,
  getReadingSessionLocalDate,
  isReadingSessionV1,
  MIN_READING_STATISTICS_BLOCK_MS,
  READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS,
  READING_SESSION_MAX_CLOCK_OFFSET_MS,
  READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES,
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

/** Keep possible timeline contenders and any clock samples they could select. */
export function selectWeeklyReadingRollupInputs(sessions: readonly ReadingSessionV1[], weekStart: string) {
  const monday = parseReadingRollupMonday(weekStart);
  // A session in another time zone can win an overlapping slice, so use the
  // broad UTC range for contenders and only apply the date filter after overlap.
  const padding = READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES * 60_000 + READING_SESSION_MAX_CLOCK_OFFSET_MS;
  const earliest = monday - padding;
  const latest = monday + WEEK_MS + padding;
  const valid = sessions.filter(isReadingSessionV1);
  const contenders = new Set<ReadingSessionV1>();
  const startsByDevice = new Map<string, { earliest: number; latest: number }>();

  for (const session of valid) {
    if (!(session.activeIntervals ?? [session]).some(({ startedAtClient, endedAtClient }) => (
      endedAtClient > earliest && startedAtClient < latest
    ))) continue;
    contenders.add(session);
    const { deviceId, startedAtClient } = session;
    const starts = startsByDevice.get(deviceId) ?? { earliest: startedAtClient, latest: startedAtClient };
    starts.earliest = Math.min(starts.earliest, startedAtClient);
    starts.latest = Math.max(starts.latest, startedAtClient);
    startsByDevice.set(deviceId, starts);
  }

  // Preserve input order because equally close clock samples keep the first one.
  return valid.filter((session) => {
    if (contenders.has(session)) return true;
    const { deviceId, clockMeasuredAtClient } = session;
    const starts = startsByDevice.get(deviceId);
    return starts !== undefined && clockMeasuredAtClient !== undefined
      && clockMeasuredAtClient >= starts.earliest - READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS
      && clockMeasuredAtClient <= starts.latest + READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS;
  });
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
