import {
  buildReadingStatistics, getReadingSessionLocalDate,
  READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS, READING_SESSION_MAX_CLOCK_OFFSET_MS,
  READING_SESSION_MAX_DURATION_MS, READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES,
  sameReadingSessionPayload, type ReadingSessionV1,
} from '../lib/readingStatistics.ts';
import { parseReadingRollupMonday } from '../lib/readingStatisticsRollup.ts';

export type ReadingRollupCarry = { sessions: ReadingSessionV1[]; sampleFloor: number };

const lowerBound = (week: string) => parseReadingRollupMonday(week)
  - READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS;
const touches = (session: ReadingSessionV1, lower: number) => (
  (session.activeIntervals ?? [session]).some(({ endedAtClient }) => endedAtClient > lower)
);

export function rollupCoversHistoryStart(sessions: readonly ReadingSessionV1[], firstWeek: string) {
  const first = parseReadingRollupMonday(firstWeek);
  // Without future clock samples, certify only histories whose possible
  // corrected dates cannot extend before the first publication week.
  return sessions.every((session) => session.completionRoundNumber !== undefined
    || session.startedAtClient - session.timezoneOffsetMinutes * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS >= first);
}

// Reviews still resolve aliases across the complete history. A late read
// could add an alias or progress to a file that is already frozen.
export function rollupCanUseFileEvidence(sessions: readonly ReadingSessionV1[], openWeek: string) {
  return sessions.every((session) => session.completionRoundNumber === undefined)
    && rollupCoversHistoryStart(sessions, openWeek);
}

export function createReadingRollupCarry(sessions: readonly ReadingSessionV1[], nextWeek: string): ReadingRollupCarry {
  const lower = lowerBound(nextWeek);
  const contenders = sessions.filter((session) => touches(session, lower));
  const earliestStart = contenders.reduce((earliest, session) => Math.min(earliest, session.startedAtClient),
    lower - READING_SESSION_MAX_DURATION_MS);
  const sampleFloor = earliestStart - READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS;
  return {
    sampleFloor,
    sessions: sessions.filter((session) => touches(session, lower) || (session.clockMeasuredAtClient ?? -Infinity) >= sampleFloor),
  };
}

export function addReadingRollupPage(carry: ReadingRollupCarry, page: readonly ReadingSessionV1[], week: string): ReadingRollupCarry {
  const lower = lowerBound(week);
  const sessions = new Map(carry.sessions.map((session) => [session.sessionId, session]));
  for (const session of page) {
    const contender = touches(session, lower);
    if (contender && session.startedAtClient - READING_SESSION_CLOCK_SAMPLE_MAX_AGE_MS < carry.sampleFloor) {
      throw new RangeError('A late session needs clock samples older than the saved input.');
    }
    const previous = sessions.get(session.sessionId);
    if (previous && !sameReadingSessionPayload(previous, session)) throw new RangeError('Conflicting rollup input.');
    if (contender || (session.clockMeasuredAtClient ?? -Infinity) >= carry.sampleFloor) sessions.set(session.sessionId, session);
  }
  return {
    sampleFloor: carry.sampleFloor,
    // Match SQLite BINARY order so equal-distance clock samples use the same tie-break.
    sessions: [...sessions.values()].sort((a, b) => Buffer.compare(Buffer.from(a.sessionId), Buffer.from(b.sessionId))),
  };
}

export function preservesClosedReadingAllocation(before: ReadingRollupCarry, after: ReadingRollupCarry, openWeek: string) {
  if (before.sessions.length === after.sessions.length) return true;
  const previousIds = new Set(before.sessions.map(({ sessionId }) => sessionId));
  const endLocalDate = getReadingSessionLocalDate(parseReadingRollupMonday(openWeek) - 1, 0);
  const bounds = { endLocalDate };
  const closedSlices = (carry: ReadingRollupCarry) => {
    const slices: string[] = [];
    // Raw slices also feed the per-book totals that include sub-two-minute blocks.
    buildReadingStatistics(carry.sessions, bounds, ({ session, startAt, durationMs }) => {
      if (previousIds.has(session.sessionId)) slices.push(JSON.stringify([session.sessionId, startAt, durationMs]));
    });
    return slices.sort();
  };
  const frozen = closedSlices(before);
  const candidate = closedSlices(after);
  return frozen.length === candidate.length && frozen.every((slice, index) => slice === candidate[index]);
}
