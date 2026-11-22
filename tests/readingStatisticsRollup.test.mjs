import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeReadingCalendarRollup,
  computeWeeklyReadingRollup,
} from '../src/lib/readingStatisticsRollup.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';

const monday = '2026-11-23';
const minute = 60_000;
const week = 7 * 86_400_000;

function session(sessionId, start, minutes, fields = {}) {
  const startedAtClient = Date.parse(start);
  const durationMs = minutes * minute;
  return Object.freeze({
    schemaVersion: 1,
    sessionId,
    bookId: 'screen-book',
    bookTitle: 'Example',
    deviceId: 'device',
    mode: 'screen',
    startedAtClient,
    endedAtClient: startedAtClient + durationMs,
    durationMs,
    startProgressPercent: 0,
    endProgressPercent: 0,
    timezoneOffsetMinutes: 0,
    localDate: getReadingSessionLocalDate(startedAtClient, fields.timezoneOffsetMinutes ?? 0),
    completed: false,
    ...fields,
  });
}

test('uses account-wide overlap and applies the gap and two-minute rules to weekly blocks', () => {
  const records = Object.freeze([
    session('screen', '2026-11-23T09:00:00Z', 3, { endProgressPercent: 20 }),
    session('tts', '2026-11-23T09:00:00Z', 2, { bookId: 'audio-book', mode: 'tts' }),
    session('screen-next', '2026-11-23T09:08:00Z', 1, { startProgressPercent: 20, endProgressPercent: 25 }),
    session('screen-isolated', '2026-11-23T09:14:01Z', 1, { startProgressPercent: 40, endProgressPercent: 41 }),
  ]);
  const result = computeWeeklyReadingRollup(records, monday);
  assert.deepEqual(result.days, [{ localDate: monday, totalMs: 4 * minute, screenMs: 2 * minute, ttsMs: 2 * minute }]);
  assert.deepEqual(result.activities, [
    {
      localDate: monday, startAt: Date.parse('2026-11-23T09:02:00Z'), durationMs: 2 * minute,
      bookId: 'screen-book', bookTitle: 'Example', mode: 'screen',
      timezoneOffsetMinutes: 0, progressSpanPercent: 5,
    },
    {
      localDate: monday, startAt: Date.parse('2026-11-23T09:00:00Z'), durationMs: 2 * minute,
      bookId: 'audio-book', bookTitle: 'Example', mode: 'tts',
      timezoneOffsetMinutes: 0, progressSpanPercent: 0,
    },
  ]);
  assert.deepEqual(result.files.find(({ fileId }) => fileId === 'screen-book'), {
    fileId: 'screen-book', titles: ['Example'], lastReadAt: Date.parse('2026-11-23T09:15:01Z'),
    filteredMs: 2 * minute,
    unfilteredMs: 3 * minute,
    progressIntervals: [[0, 25], [40, 41]],
    absoluteMaxProgressPercent: 41,
  });
});

test('uses clock samples outside the week and clips at corrected local midnight', () => {
  const sample = session('sample', '2026-11-22T20:00:00Z', 1, {
    clockOffsetMs: 2 * minute,
    clockUncertaintyMs: 0,
    clockMeasuredAtClient: Date.parse('2026-11-22T20:00:00Z'),
    bookId: 'sample-book',
  });
  const crossing = session('crossing', '2026-11-22T22:57:00Z', 3, {
    timezoneOffsetMinutes: -60, startProgressPercent: 2, endProgressPercent: 14,
  });
  const result = computeWeeklyReadingRollup([sample, crossing], monday);
  assert.deepEqual(result.days, [{ localDate: monday, totalMs: 2 * minute, screenMs: 2 * minute, ttsMs: 0 }]);
  assert.equal(result.activities[0].startAt, Date.parse('2026-11-22T23:00:00Z'));
  assert.equal(result.activities[0].progressSpanPercent, null);
  assert.deepEqual(result.files, [{
    fileId: 'screen-book', titles: ['Example'], lastReadAt: Date.parse('2026-11-22T23:02:00Z'), filteredMs: 2 * minute, unfilteredMs: 2 * minute,
    progressIntervals: [[2, 14]], absoluteMaxProgressPercent: 14,
  }]);
});

test('preserves progress from overlap losers and stationary reads while excluding completion markers', () => {
  const records = [
    session('screen', '2026-11-23T09:00:00Z', 3, { startProgressPercent: 20, endProgressPercent: 10 }),
    session('tts', '2026-11-23T09:00:00Z', 3, { bookId: 'audio-book', mode: 'tts' }),
    session('later', '2026-11-23T10:00:00Z', 1, { startProgressPercent: 19, endProgressPercent: 25 }),
    session('stationary', '2026-11-23T11:00:00Z', 1, { startProgressPercent: 65, endProgressPercent: 65 }),
    session('marker', '2026-11-23T12:00:00Z', 3, {
      startProgressPercent: 65, endProgressPercent: 100,
      completed: true, completionRoundNumber: 1,
      completionConfirmedAtClient: Date.parse('2026-11-23T12:03:00Z'),
    }),
  ];
  const result = computeWeeklyReadingRollup(records, monday);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].mode, 'tts');
  assert.deepEqual(result.files.find(({ fileId }) => fileId === 'screen-book'), {
    fileId: 'screen-book', titles: ['Example'], lastReadAt: Date.parse('2026-11-23T11:01:00Z'), filteredMs: 0, unfilteredMs: 2 * minute,
    progressIntervals: [[10, 25]], absoluteMaxProgressPercent: 65,
  });
});

test('assembles ten consecutive Mondays with explicit empty weeks and rejects invalid windows', () => {
  const newest = Date.parse(monday);
  const weeks = Object.freeze(Array.from({ length: 10 }, (_, index) => {
    const weekStart = getReadingSessionLocalDate(newest - (9 - index) * week, 0);
    const records = index === 0 || index === 9
      ? [session(`read-${index}`, `${weekStart}T09:00:00Z`, 2)]
      : [];
    return computeWeeklyReadingRollup(records, weekStart);
  }));
  assert.deepEqual(weeks[1], { weekStart: weeks[1].weekStart, days: [], activities: [], files: [] });
  assert.deepEqual(computeReadingCalendarRollup(weeks), {
    weekStarts: [...weeks].reverse().map(({ weekStart }) => weekStart),
    days: [...weeks[9].days, ...weeks[0].days],
  });
  assert.throws(() => computeReadingCalendarRollup(weeks.slice(1)), RangeError);
  assert.throws(() => computeReadingCalendarRollup([...weeks.slice(1), weeks[9]]), RangeError);
  assert.throws(() => computeReadingCalendarRollup([
    computeWeeklyReadingRollup([], getReadingSessionLocalDate(newest - 10 * week, 0)),
    ...weeks.slice(1),
  ]), RangeError);
  assert.throws(() => computeReadingCalendarRollup([
    { ...weeks[0], weekStart: '2026-11-24' }, ...weeks.slice(1),
  ]), RangeError);
  assert.throws(() => computeWeeklyReadingRollup([], '2026-02-30'), RangeError);
});
