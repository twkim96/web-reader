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

export type ReadingRollupActivity = Omit<ReadingActivityBlock, 'session'> & Pick<
  ReadingSessionV1,
  'bookId' | 'bookTitle' | 'mode' | 'timezoneOffsetMinutes'
>;

type ProgressInterval = [startPercent: number, endPercent: number];

export type ReadingFileRollup = {
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

export type PublishedReadingFiles = { firstDay: string; lastDay: string; files: ReadingFileRollup[] };

export const readingDayOutsidePublication = (range: Pick<PublishedReadingFiles, 'firstDay' | 'lastDay'>) => (
  (localDate: string) => localDate < range.firstDay || localDate > range.lastDay
);

const DAY_MS = 86_400_000;
const CALENDAR_WEEK_COUNT = 10;
const WEEK_MS = 7 * DAY_MS;

export const readingRollupDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function readingRollupWeekForDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || readingRollupDayKey(date.getTime()) !== day) return null;
  return readingRollupDayKey(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS);
}

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

export function mergeReadingFileRollups(...sources: readonly (readonly ReadingFileRollup[])[]): ReadingFileRollup[] {
  const files = new Map<string, ReadingFileRollup>();
  for (const source of sources) {
    for (const file of source) {
      const previous = files.get(file.fileId);
      files.set(file.fileId, previous ? {
        fileId: file.fileId,
        titles: [...new Set([...previous.titles, ...file.titles])].sort(),
        lastReadAt: Math.max(previous.lastReadAt, file.lastReadAt),
        filteredMs: previous.filteredMs + file.filteredMs,
        unfilteredMs: previous.unfilteredMs + file.unfilteredMs,
        progressIntervals: unionProgressIntervals([...previous.progressIntervals, ...file.progressIntervals]),
        absoluteMaxProgressPercent: Math.max(previous.absoluteMaxProgressPercent, file.absoluteMaxProgressPercent),
      } : file);
    }
  }
  return [...files.values()].sort((left, right) => left.fileId.localeCompare(right.fileId));
}

export function parseReadingFileRollups(value: unknown): ReadingFileRollup[] | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const validPercent = (percent: unknown): percent is number => typeof percent === 'number'
    && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  for (const file of value) {
    if (!file || typeof file.fileId !== 'string' || !file.fileId || ids.has(file.fileId)
      || !Array.isArray(file.titles) || !file.titles.length || !file.titles.every((title: unknown) => typeof title === 'string')
      || ![file.lastReadAt, file.filteredMs, file.unfilteredMs].every((ms) => Number.isSafeInteger(ms) && ms >= 0)
      || !validPercent(file.absoluteMaxProgressPercent) || !Array.isArray(file.progressIntervals)
      || !file.progressIntervals.every((pair: unknown) => Array.isArray(pair) && pair.length === 2
        && pair.every(validPercent) && pair[0] < pair[1])) return null;
    ids.add(file.fileId);
  }
  return value;
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
  return {
    weekStart,
    days: filtered.days,
    activities: activities.reverse().sort((left, right) => right.localDate.localeCompare(left.localDate)),
    files: computeReadingFileRollups(sessions, { bounds, filteredMs }),
  };
}

export function computeReadingFileRollups(sessions: readonly ReadingSessionV1[], {
  bounds = {}, filteredMs, includeDate = () => true,
}: {
  bounds?: { startLocalDate?: string; endLocalDate?: string };
  filteredMs?: ReadonlyMap<string, number>;
  includeDate?: (localDate: string) => boolean;
} = {}): ReadingFileRollup[] {
  const files = new Map<string, Omit<ReadingFileRollup, 'titles'> & { titles: Set<string> }>();
  buildReadingStatistics(sessions, bounds, ({ session, durationMs, localDate }) => {
    if (includeDate(localDate)) files.get(session.bookId)!.unfilteredMs += durationMs;
  }, undefined, (session, lastAt, localDate) => {
    const { bookId, bookTitle, completionRoundNumber, startProgressPercent, endProgressPercent } = session;
    if (completionRoundNumber !== undefined || !includeDate(localDate)) return;
    const file = files.get(bookId) ?? {
      fileId: bookId,
      titles: new Set<string>(),
      lastReadAt: 0,
      filteredMs: filteredMs?.get(bookId) ?? 0,
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

  return [...files.values()].map((file) => ({
    ...file,
    titles: [...file.titles].sort(),
    progressIntervals: unionProgressIntervals(file.progressIntervals),
  })).sort((left, right) => left.fileId.localeCompare(right.fileId));
}

export function extendPublishedReadingFiles(history: PublishedReadingFiles, sessions: readonly ReadingSessionV1[]) {
  return mergeReadingFileRollups(history.files, computeReadingFileRollups(sessions, { includeDate: readingDayOutsidePublication(history) }));
}

export function getReadingFileTime(sessions: readonly ReadingSessionV1[], fileId: string, history?: PublishedReadingFiles | null) {
  if (!history) return buildReadingStatistics(sessions).books.find(({ bookId }) => bookId === fileId)?.totalMs ?? 0;
  const outside = readingDayOutsidePublication(history);
  let totalMs = history.files.find((file) => file.fileId === fileId)?.unfilteredMs ?? 0;
  buildReadingStatistics(sessions, {}, ({ session, localDate, durationMs }) => {
    if (session.bookId === fileId && outside(localDate)) totalMs += durationMs;
  });
  return totalMs;
}

export function computeReadingCalendarRollup(weeks: readonly Pick<WeeklyReadingRollup, 'weekStart' | 'days'>[]): ReadingCalendarRollup {
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
