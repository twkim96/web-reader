import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity.ts';
import { isReadingSessionV1, type ReadingDayStatistics } from '../lib/readingStatistics.ts';
import type { PublishedReadingCalendar, PublishedReadingWeek } from '../lib/readingRollupCalendar.ts';
import { parseReadingReportBooks, summarizeReadingReportBooks, type PublishedReadingReportBooks, type ReadingReportRange } from '../lib/readingStatisticsReport.ts';
import { parseReadingFileRollups, parseReadingRollupMonday, readingRollupDayKey, readingRollupWeekForDay } from '../lib/readingStatisticsRollup.ts';
import type { ReadingRollupCarry } from './readingRollupInputs.ts';

const day = 86_400_000;
const week = day * 7;
const calendarBlock = week * 10;

async function publishedRange(db: Firestore, uid: string) {
  const root = db.doc(`artifacts/${APP_ID}/readingStatsRollupJobsV1/${uid}`);
  const pointer = (await root.collection('readingStatsRollupManifestsV1').doc('current').get()).data();
  if (!pointer) return null;
  if (pointer.schemaVersion !== 1) throw new Error('Unsupported reading rollup publication.');
  const first = parseReadingRollupMonday(pointer.firstWeek);
  const through = parseReadingRollupMonday(pointer.publishedThroughWeek);
  const lastCalendar = parseReadingRollupMonday(pointer.lastCalendarWeek);
  if (lastCalendar < first + 9 * week || (lastCalendar - first - 9 * week) % calendarBlock !== 0
    || through < lastCalendar || through - lastCalendar >= calendarBlock) throw new Error('Invalid reading rollup publication.');
  return { root, first, through, lastCalendar, tail: pointer.calendarTail as unknown, coversHistoryStart: pointer.coversHistoryStart === true,
    sourceThrough: pointer.sourceThrough instanceof Timestamp ? pointer.sourceThrough : null };
}

async function readFileTotals(db: Firestore, uid: string) {
  const range = await publishedRange(db, uid);
  if (!range) return null;
  const snapshot = await range.root.collection('readingStatsRollupFilesV1').doc('current').get();
  if (snapshot.get('throughWeek') !== readingRollupDayKey(range.through)) return null;
  const payload = JSON.parse(snapshot.get('payload'));
  const files = parseReadingFileRollups(payload.files);
  return files ? { range, files, carry: payload.carry as unknown, books: payload.books as unknown } : null;
}

export async function readPublishedReadingFiles(db: Firestore, uid: string) {
  const published = await readFileTotals(db, uid);
  if (!published) return null;
  return { firstDay: readingRollupDayKey(published.range.first), lastDay: readingRollupDayKey(published.range.through + 6 * day), files: published.files };
}

export async function readPublishedReadingEvidenceInputs(db: Firestore, uid: string) {
  const published = await readFileTotals(db, uid);
  if (!published?.range.coversHistoryStart || !published.range.sourceThrough) return null;
  const { range, files } = published;
  const carry = published.carry as ReadingRollupCarry | undefined;
  if (!carry || !Number.isSafeInteger(carry.sampleFloor) || !Array.isArray(carry.sessions) || !carry.sessions.every(isReadingSessionV1)) return null;
  return { files, carry, nextWeek: readingRollupDayKey(range.through + week),
    sourceThrough: published.range.sourceThrough };
}

export async function hasPublishedReadingAuditCoverage(db: Firestore, uid: string) {
  const range = await publishedRange(db, uid);
  if (!range?.coversHistoryStart) return false;
  await readCalendarRange(db, range);
  return true;
}

function readDays(input: unknown, first: number, last: number): ReadingDayStatistics[] {
  if (!Array.isArray(input)) throw new Error('Invalid reading rollup days.');
  const firstKey = readingRollupDayKey(first);
  const lastKey = readingRollupDayKey(last);
  const seen = new Set<string>();
  return input.map((entry) => {
    if (!entry || typeof entry.localDate !== 'string' || !readingRollupWeekForDay(entry.localDate)
      || entry.localDate < firstKey || entry.localDate > lastKey || seen.has(entry.localDate)
      || ![entry.totalMs, entry.screenMs, entry.ttsMs].every((ms) => Number.isSafeInteger(ms) && ms >= 0)
      || entry.totalMs !== entry.screenMs + entry.ttsMs) throw new Error('Invalid reading rollup day.');
    const { localDate, totalMs, screenMs, ttsMs } = entry;
    seen.add(localDate);
    return { localDate, totalMs, screenMs, ttsMs };
  });
}

async function readCalendarRange(db: Firestore, range: NonNullable<Awaited<ReturnType<typeof publishedRange>>>): Promise<PublishedReadingCalendar> {
  const { root, first, through, lastCalendar, tail } = range;
  const calendars = root.collection('readingStatsRollupCalendarsV1');
  const weeks = root.collection('readingStatsRollupWeeksV1');
  const ends = Array.from({ length: 1 + (lastCalendar - first - 9 * week) / calendarBlock }, (_, i) => first + 9 * week + i * calendarBlock);
  const trailing = Array.from({ length: (through - lastCalendar) / week }, (_, i) => lastCalendar + (i + 1) * week);
  const snapshots = await db.getAll(...ends.map((end) => calendars.doc(readingRollupDayKey(end))),
    ...(tail === undefined ? trailing.map((start) => weeks.doc(readingRollupDayKey(start))) : []));
  const days = ends.flatMap((end, i) => {
    const block = JSON.parse(snapshots[i].get('payload'));
    if (!Array.isArray(block.weekStarts) || block.weekStarts.length !== 10
      || block.weekStarts.some((start: unknown, j: number) => start !== readingRollupDayKey(end - j * week))) {
      throw new Error('Incomplete reading rollup calendar.');
    }
    return readDays(block.days, end - 9 * week, end + 6 * day);
  });
  const tails: unknown = tail === undefined ? snapshots.slice(ends.length).map((snapshot) => JSON.parse(snapshot.get('payload'))) : tail;
  if (!Array.isArray(tails) || tails.length !== trailing.length) throw new Error('Incomplete reading rollup calendar tail.');
  for (const [i, start] of trailing.entries()) {
    if (tails[i]?.weekStart !== readingRollupDayKey(start)) throw new Error('Invalid reading rollup week.');
    days.push(...readDays(tails[i].days, start, start + 6 * day));
  }
  return { firstDay: readingRollupDayKey(first), lastDay: readingRollupDayKey(through + 6 * day), days };
}

export async function readPublishedReadingCalendar(db: Firestore, uid: string): Promise<PublishedReadingCalendar | null> {
  const range = await publishedRange(db, uid);
  return range ? readCalendarRange(db, range) : null;
}

function readWeekActivities(payload: string, weekStart: string) {
  const detail = JSON.parse(payload) as PublishedReadingWeek;
  if (detail.weekStart !== weekStart || !Array.isArray(detail.activities)) throw new Error('Incomplete reading rollup detail.');
  const activities = detail.activities.map((row) => {
    const { localDate, bookId, bookTitle, mode, startAt, durationMs, timezoneOffsetMinutes, progressSpanPercent } = row;
    if (readingRollupWeekForDay(localDate) !== weekStart || typeof bookId !== 'string' || typeof bookTitle !== 'string'
      || (mode !== 'screen' && mode !== 'tts') || !Number.isSafeInteger(startAt)
      || !Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(timezoneOffsetMinutes)
      || (progressSpanPercent !== null && (!Number.isFinite(progressSpanPercent) || progressSpanPercent < 0 || progressSpanPercent > 100))) {
      throw new Error('Invalid reading rollup activity.');
    }
    return { localDate, bookId, bookTitle, mode, startAt, durationMs, timezoneOffsetMinutes, progressSpanPercent };
  });
  return activities;
}

export async function readPublishedReadingWeek(db: Firestore, uid: string, weekStart: string): Promise<PublishedReadingWeek | null> {
  const start = parseReadingRollupMonday(weekStart);
  const range = await publishedRange(db, uid);
  if (!range || start < range.first || start > range.through) return null;
  const snapshot = await range.root.collection('readingStatsRollupWeeksV1').doc(weekStart).get();
  return { weekStart, activities: readWeekActivities(snapshot.get('payload'), weekStart) };
}

export async function readPublishedReadingReportBooks(
  db: Firestore, uid: string, selected?: ReadingReportRange,
): Promise<PublishedReadingReportBooks | null> {
  if (!selected) {
    const published = await readFileTotals(db, uid);
    const books = parseReadingReportBooks(published?.books);
    if (!published || !books) return null;
    const { first, through } = published.range;
    return { firstDay: readingRollupDayKey(first), lastDay: readingRollupDayKey(through + 6 * day), books };
  }

  const range = await publishedRange(db, uid);
  const { firstDay, lastDay } = selected;
  if (!range || firstDay < readingRollupDayKey(range.first) || lastDay > readingRollupDayKey(range.through + 6 * day)) return null;
  const start = parseReadingRollupMonday(readingRollupWeekForDay(firstDay)!);
  const end = Date.parse(lastDay);
  const weeks = range.root.collection('readingStatsRollupWeeksV1');
  const refs = Array.from({ length: 1 + Math.floor((end - start) / week) }, (_, index) => weeks.doc(readingRollupDayKey(start + index * week)));
  const snapshots = await db.getAll(...refs);
  const activities = snapshots.flatMap((snapshot) => readWeekActivities(snapshot.get('payload'), snapshot.id)
    .filter(({ localDate }) => localDate >= firstDay && localDate <= lastDay));
  return { ...selected, books: summarizeReadingReportBooks(activities) };
}
