import type { PublishedReadingCalendar } from './readingRollupCalendar';
import {
  buildReadingStatistics, getReadingSessionLocalStartsBefore, isReadingSessionV1,
  READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS, READING_SESSION_MAX_CLOCK_OFFSET_MS, READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES,
  type ReadingSessionV1,
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

const dayMs = 86_400_000;
const weekMs = 7 * dayMs;
const tuesdayCutoffEpoch = Date.UTC(1970, 0, 6, 9);

export function latestReadingPublicationCutoff(now: number) {
  return tuesdayCutoffEpoch + Math.floor((now - tuesdayCutoffEpoch) / weekMs) * weekMs;
}

export function shouldCheckReadingPublication(now: number, lastAttempt: number, lastDay?: string, manual = false) {
  const cutoff = latestReadingPublicationCutoff(now);
  if (manual) return lastAttempt < cutoff || now - lastAttempt >= 15_000;
  // A publication ends on Sunday. Its next week closes the Tuesday after that week.
  if (lastDay && cutoff < Date.parse(lastDay) + 9 * dayMs + 9 * 3_600_000) return false;
  return now - lastAttempt >= 3_600_000 || lastAttempt < cutoff;
}

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
    || !carry.sessions.every(isReadingSessionV1) || new Set(carry.sessions.map(({ sessionId }) => sessionId)).size !== carry.sessions.length) return null;
  return { ...archive, carry };
}

function cannotAffectClosedAllocation(
  openDay: number, received: readonly ReadingSessionV1[], incoming: readonly ReadingSessionV1[],
) {
  let latestClosedUtc = -Infinity;
  let minimumOffset = 0;
  const firstNewSample = new Map<string, number>();
  for (const rows of [received, incoming]) {
    for (const session of rows) {
      latestClosedUtc = Math.max(latestClosedUtc, openDay + session.timezoneOffsetMinutes * 60_000);
      minimumOffset = Math.min(minimumOffset, session.clockOffsetMs ?? 0);
    }
  }
  for (const session of incoming) {
    if (session.startedAtClient + minimumOffset < latestClosedUtc) return false;
    if (session.clockMeasuredAtClient !== undefined) {
      firstNewSample.set(session.deviceId, Math.min(session.clockMeasuredAtClient,
        firstNewSample.get(session.deviceId) ?? Infinity));
    }
  }
  // A later sample cannot displace an existing closer sample for any input
  // whose timing or clock domain could affect a closed slice.
  return received.every(({ deviceId, startedAtClient, clockMeasuredAtClient }) => {
    if (startedAtClient + minimumOffset >= latestClosedUtc || !firstNewSample.has(deviceId)) return true;
    if (clockMeasuredAtClient === undefined) return false;
    const existingDistance = Math.abs(clockMeasuredAtClient - startedAtClient);
    return existingDistance <= READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS
      && startedAtClient + existingDistance < firstNewSample.get(deviceId)!;
  });
}

/** Keep the published input and admit only additions that leave its date boundary intact. */
export function selectReadingRollupTail<T extends ReadingSessionV1>(
  point: Pick<ReadingRollupCheckpoint, 'lastDay' | 'sampleFloor'>,
  received: readonly ReadingSessionV1[],
  incoming: readonly T[],
): T[] {
  const openDay = Date.parse(point.lastDay) + dayMs;
  const eligible = incoming.filter((session) => session.completionRoundNumber === undefined
    && session.startedAtClient - READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS >= point.sampleFloor);
  if (eligible.length === 0) return [];
  const latestClosedStart = openDay + READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES * 60_000 + READING_SESSION_MAX_CLOCK_OFFSET_MS;
  const canAffectClosed = (session: ReadingSessionV1) => session.startedAtClient < latestClosedStart
    || (session.clockMeasuredAtClient ?? Infinity) < latestClosedStart + READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS;
  if (!eligible.some(canAffectClosed) || cannotAffectClosedAllocation(openDay, received, eligible)) return eligible;
  const closedSignature = (sessions: readonly ReadingSessionV1[]) => {
    const starts = getReadingSessionLocalStartsBefore(sessions, openDay);
    if (starts.size === 0) return '';
    const slices: [string, number, number][] = [];
    buildReadingStatistics(sessions, { endLocalDate: point.lastDay }, ({ session, startAt, durationMs }) => {
      slices.push([session.sessionId, startAt, durationMs]);
    });
    return JSON.stringify([[...starts].sort(), slices.sort()]);
  };
  const boundaryInputs = received.filter(canAffectClosed);
  const fixed = closedSignature(boundaryInputs);
  // Limit checks to inputs that can affect the seam and keep the decision
  // independent of how the upload-ordered stream was paginated.
  return eligible.filter((session) => {
    if (!canAffectClosed(session)) return true;
    boundaryInputs.push(session);
    if (closedSignature(boundaryInputs) === fixed) return true;
    boundaryInputs.pop();
    return false;
  });
}
