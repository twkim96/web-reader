import assert from 'node:assert/strict';
import test from 'node:test';
import { openBackfillState, stageReadingStatisticsBackfill } from '../scripts/backfill-reading-statistics.mjs';

const cutoff = Date.parse('2026-11-24T12:00:00Z');
const week = '2026-11-16';
const date = '2026-11-16';
const start = Date.parse(date + 'T09:00:00Z');

const entry = (id, createdAt = cutoff - 10_000) => ({
  id, createdAt, updatedAt: createdAt,
  data: {
    schemaVersion: 1, sessionId: id, bookId: 'book', bookTitle: 'Book', deviceId: 'test-device',
    mode: 'screen', startedAtClient: start, endedAtClient: start + 180_000,
    durationMs: 180_000, startProgressPercent: 1, endProgressPercent: 8,
    timezoneOffsetMinutes: 0, localDate: date, completed: false,
  },
});

test('resumes from a durable cursor, keeps the cutoff, and shares the daily cap across accounts', async (t) => {
  const db = openBackfillState(':memory:');
  t.after(() => db.close());
  let now = cutoff;
  let source = [entry('old')];
  const calls = [];
  const options = {
    project: 'demo', uid: 'one', firstWeek: week, throughWeek: week,
    dailyReads: 1, currentTime: () => now,
    async readPage(cursor, limit) {
      calls.push(cursor);
      return { readTime: now, documents: source.filter(({ id }) => !cursor || id > cursor).slice(0, limit) };
    },
  };
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'reading');
  assert.equal((await stageReadingStatisticsBackfill(db, { ...options, uid: 'two' })).reservedReadsToday, 1);
  assert.deepEqual(calls, [null]);

  now += 86_400_000;
  source = [...source, entry('z-late', now)];
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'reading');
  now += 86_400_000;
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'complete');
  assert.deepEqual(calls, [null, 'old', 'z-late']);
  assert.equal(db.prepare('SELECT COUNT(*) AS size FROM sessions').get().size, 1);
  const [saved] = db.prepare('SELECT cutoff, payload FROM weeks').all();
  assert.equal(saved.cutoff, cutoff);
  assert.equal(JSON.parse(saved.payload).days[0].totalMs, 180_000);
  assert.equal((await stageReadingStatisticsBackfill(db, options)).stagedWeeks, 0);
  assert.deepEqual(calls, [null, 'old', 'z-late']);
});

test('refuses to finish a history generation after encountering a source edited past the cutoff', async (t) => {
  const db = openBackfillState(':memory:');
  t.after(() => db.close());
  let now = cutoff;
  let source = [entry('first'), { ...entry('second'), updatedAt: cutoff + 1 }];
  const options = {
    project: 'demo', uid: 'one', firstWeek: week, throughWeek: week,
    dailyReads: 1, currentTime: () => now,
    async readPage(cursor, limit) {
      return { readTime: now, documents: source.filter(({ id }) => !cursor || id > cursor).slice(0, limit) };
    },
  };
  await stageReadingStatisticsBackfill(db, options);
  now += 86_400_000;
  await assert.rejects(stageReadingStatisticsBackfill(db, options), /changed or malformed/);
  assert.equal(db.prepare('SELECT cursor FROM jobs').get().cursor, 'first');
  assert.equal(db.prepare('SELECT COUNT(*) AS size FROM weeks').get().size, 0);
});
