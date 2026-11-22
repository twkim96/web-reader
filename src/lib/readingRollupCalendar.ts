import type { ReadingDayStatistics } from './readingStatistics';
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
