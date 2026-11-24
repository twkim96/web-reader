import type { ReadingDayStatistics, ReadingSessionV1 } from './readingStatistics';
import type { ReadingRollupActivity } from './readingStatisticsRollup';

export type PublishedReadingCalendar = {
  firstDay: string;
  lastDay: string;
  days: ReadingDayStatistics[];
};

export type PublishedReadingWeek = { weekStart: string; activities: ReadingRollupActivity[] };

export function publishedCalendarCovers(calendar: PublishedReadingCalendar, day: string) {
  return day >= calendar.firstDay && day <= calendar.lastDay;
}

export function mergePublishedCalendarDays(local: ReadingDayStatistics[], calendar: PublishedReadingCalendar | null) {
  if (!calendar) return local;
  // The whole published range is authoritative, including days with zero reading.
  return [...local.filter(({ localDate }) => !publishedCalendarCovers(calendar, localDate)), ...calendar.days];
}

export function canMergeLocalReadingWithPublication(
  local: {
    sessions: readonly ReadingSessionV1[];
    rawHistoryComplete: boolean;
    tailComplete: boolean;
    published?: Pick<PublishedReadingCalendar, 'firstDay' | 'lastDay'>;
  } | null,
  publication: Pick<PublishedReadingCalendar, 'firstDay' | 'lastDay'>,
) {
  if (!local) return false;
  if (local.published) {
    return local.tailComplete && local.published.firstDay === publication.firstDay
      && local.published.lastDay === publication.lastDay;
  }
  return local.rawHistoryComplete && !hasPublishedBoundaryClockRisk(local.sessions, publication);
}

export function hasPublishedBoundaryClockRisk(
  sessions: readonly ReadingSessionV1[],
  { firstDay, lastDay }: Pick<PublishedReadingCalendar, 'firstDay' | 'lastDay'>,
) {
  const offsets = new Map<string, { min: number; max: number }>();
  for (const { clockOffsetMs, deviceId } of sessions) {
    if (!clockOffsetMs) continue;
    const range = offsets.get(deviceId) ?? { min: 0, max: 0 };
    range.min = Math.min(range.min, clockOffsetMs);
    range.max = Math.max(range.max, clockOffsetMs);
    offsets.set(deviceId, range);
  }
  const first = Date.parse(firstDay), afterLast = Date.parse(lastDay) + 86_400_000;
  return sessions.some((session) => {
    if (session.completionRoundNumber !== undefined) return false;
    const range = offsets.get(session.deviceId);
    if (!range) return false;
    const timeZone = session.timezoneOffsetMinutes * 60_000;
    return (session.activeIntervals ?? [session]).some(({ startedAtClient, endedAtClient }) => {
      const earliest = startedAtClient + range.min - timeZone;
      const latest = endedAtClient + range.max - timeZone;
      return (earliest < first && latest > first) || (earliest < afterLast && latest > afterLast);
    });
  });
}
