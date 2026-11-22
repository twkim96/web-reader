import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { openBackfillState, stageReadingStatisticsBackfill } from '../scripts/backfill-reading-statistics.mjs';
import {
  computeReadingCalendarRollup,
  computeWeeklyReadingRollup,
  selectWeeklyReadingRollupInputs,
} from '../src/lib/readingStatisticsRollup.ts';

const cutoff = Date.parse('2026-11-24T12:00:00Z');
const cutoffTimestamp = new Timestamp(cutoff / 1000, 123_000);
const week = '2026-11-16';
const date = '2026-11-16';
const start = Date.parse(date + 'T09:00:00Z');

const entry = (id, createdAt = Timestamp.fromMillis(cutoff - 10_000)) => ({
  id, createdAt, updatedAt: createdAt,
  data: {
    schemaVersion: 1, sessionId: id, bookId: 'book', bookTitle: 'Book', deviceId: 'test-device',
    mode: 'screen', startedAtClient: start, endedAtClient: start + 180_000,
    durationMs: 180_000, startProgressPercent: 1, endProgressPercent: 8,
    timezoneOffsetMinutes: 0, localDate: date, completed: false,
  },
});

test('resumes from a durable cursor, keeps the cutoff, and shares the daily cap across accounts', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'reading-backfill-'));
  const path = join(directory, 'stage.sqlite');
  let db = openBackfillState(path);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true });
  });
  let now = cutoff;
  let source = [entry('old')];
  const calls = [];
  const options = {
    project: 'demo', uid: 'one', firstWeek: week, throughWeek: week,
    dailyReads: 1, currentTime: () => now,
    async readPage(cursor, limit) {
      calls.push(cursor);
      return {
        readTime: now === cutoff ? cutoffTimestamp : Timestamp.fromMillis(now),
        documents: source.filter(({ id }) => !cursor || id > cursor).slice(0, limit),
      };
    },
  };
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'reading');
  assert.equal((await stageReadingStatisticsBackfill(db, { ...options, uid: 'two' })).reservedReadsToday, 1);
  assert.deepEqual(calls, [null]);

  db.close();
  db = openBackfillState(path);
  now += 86_400_000;
  // The later document has the same integer millisecond as the original freeze.
  source = [...source, entry('z-late', new Timestamp(cutoffTimestamp.seconds, 124_000))];
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'reading');
  now += 86_400_000;
  assert.equal((await stageReadingStatisticsBackfill(db, options)).status, 'complete');
  assert.deepEqual(calls, [null, 'old', 'z-late']);
  assert.equal(db.prepare('SELECT COUNT(*) AS size FROM sessions').get().size, 1);
  const [saved] = db.prepare('SELECT cutoff, cutoff_submillis, payload FROM weeks').all();
  assert.equal(saved.cutoff, cutoff);
  assert.equal(saved.cutoff_submillis, 123_000);
  assert.equal(JSON.parse(saved.payload).days[0].totalMs, 180_000);
  assert.equal((await stageReadingStatisticsBackfill(db, options)).stagedWeeks, 0);
  assert.deepEqual(calls, [null, 'old', 'z-late']);
});

test('blocks a changed or malformed page without re-reading it or staging a partial week', async (t) => {
  const db = openBackfillState(':memory:');
  t.after(() => db.close());
  let now = cutoff;
  const calls = [];
  const source = [entry('first'), entry('middle'), { ...entry('second'), updatedAt: new Timestamp(cutoffTimestamp.seconds, 124_000) }];
  const malformed = { ...entry('bad'), data: { schemaVersion: 1 } };
  const options = {
    project: 'demo', uid: 'one', firstWeek: week, throughWeek: week,
    dailyReads: 2, currentTime: () => now,
    async readPage(cursor, limit) {
      calls.push(cursor);
      return {
        readTime: now === cutoff ? cutoffTimestamp : Timestamp.fromMillis(now),
        documents: source.filter(({ id }) => !cursor || id > cursor).slice(0, limit),
      };
    },
  };
  await stageReadingStatisticsBackfill(db, options);
  now += 86_400_000;
  const blocked = await stageReadingStatisticsBackfill(db, options);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blocked, { documentId: 'second', reason: 'changed-after-cutoff' });
  assert.equal(db.prepare('SELECT cursor FROM jobs').get().cursor, 'middle');
  assert.equal(db.prepare('SELECT COUNT(*) AS size FROM weeks').get().size, 0);
  now += 86_400_000;
  assert.equal((await stageReadingStatisticsBackfill(db, options)).reservedReadsToday, 0);
  assert.deepEqual(calls, [null, 'middle']);

  const malformedOptions = {
    ...options, uid: 'two', readPage: async () => ({ readTime: Timestamp.fromMillis(now), documents: [malformed] }),
  };
  const malformedResult = await stageReadingStatisticsBackfill(db, malformedOptions);
  assert.deepEqual(malformedResult.blocked, { documentId: 'bad', reason: 'invalid-session' });
  assert.deepEqual(await stageReadingStatisticsBackfill(db, {
    ...malformedOptions, readPage: async () => assert.fail('blocked jobs must not read'),
  }), malformedResult);
});

test('preserves an older SQLite job without treating its millisecond cutoff as precise', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reading-backfill-'));
  const path = join(directory, 'stage.sqlite');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE jobs (
        project TEXT NOT NULL, uid TEXT NOT NULL, first_week TEXT NOT NULL, next_week TEXT NOT NULL,
        cutoff INTEGER, cursor TEXT, ingested INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project, uid)
      );
    `);
    old.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)').run('demo', 'legacy', week, week, cutoff, 'saved-cursor', 0);
    old.close();

    const db = openBackfillState(path);
    try {
      await assert.rejects(stageReadingStatisticsBackfill(db, {
        project: 'demo', uid: 'legacy', firstWeek: week, throughWeek: week,
        currentTime: () => cutoff,
        readPage: async () => assert.fail('the older cutoff must stop before a read'),
      }), /predates precise cutoffs/);
      assert.equal(db.prepare('SELECT cursor FROM jobs').get().cursor, 'saved-cursor');
      assert.equal(db.prepare('SELECT COUNT(*) AS size FROM budgets').get().size, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('compares the nine SQLite backfill weeks and first regular close against the same full history', async (t) => {
  const db = openBackfillState(':memory:');
  t.after(() => db.close());
  const firstWeek = '2026-09-14';
  const lastBackfillWeek = '2026-11-09';
  const macTime = Timestamp.fromDate(new Date('2026-11-23T08:00:00Z'));
  const regularClose = Timestamp.fromDate(new Date('2026-11-24T09:00:00Z'));
  function placed(id, iso, timestamp, fields = {}) {
    const doc = entry(id, timestamp);
    const startedAtClient = Date.parse(iso);
    return {
      ...doc,
      data: {
        ...doc.data, startedAtClient, endedAtClient: startedAtClient + doc.data.durationMs,
        localDate: iso.slice(0, 10), ...fields,
      },
    };
  }
  const old = Timestamp.fromDate(new Date('2026-11-17T01:00:00Z'));
  const measured = Date.parse('2026-11-15T09:00:00Z');
  const initial = [
    placed('first', '2026-09-14T09:00:00Z', old),
    placed('clock', '2026-11-15T09:00:00Z', old, {
      clockOffsetMs: 60_000, clockUncertaintyMs: 0, clockMeasuredAtClient: measured,
    }),
    placed('sunday', '2026-11-15T23:58:00Z', old),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const staged = await stageReadingStatisticsBackfill(db, {
    project: 'demo', uid: 'pilot', firstWeek, throughWeek: lastBackfillWeek, dailyWeeks: 9,
    currentTime: () => macTime.toMillis(),
    async readPage() { return { readTime: macTime, documents: initial }; },
  });
  assert.equal(staged.stagedWeeks, 9);
  const savedWeeks = db.prepare('SELECT payload FROM weeks ORDER BY week').all().map(({ payload }) => JSON.parse(payload));
  assert.equal(savedWeeks.filter(({ days }) => days.length === 0).length, 7);
  const stagedSessions = db.prepare('SELECT payload FROM sessions ORDER BY id').all().map(({ payload }) => JSON.parse(payload));
  const delta = [placed('monday', '2026-11-16T00:03:00Z', regularClose)];
  const aligned = [...stagedSessions, ...delta.map(({ data }) => data)].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const full = [...initial, ...delta].sort((a, b) => a.id.localeCompare(b.id)).map(({ data }) => data);
  const close = computeWeeklyReadingRollup(selectWeeklyReadingRollupInputs(aligned, week), week);
  const baseline = [...savedWeeks.map(({ weekStart }) => computeWeeklyReadingRollup(full, weekStart)), computeWeeklyReadingRollup(full, week)];
  assert.equal(close.days[0].totalMs, 300_000);
  assert.deepEqual([...savedWeeks, close], baseline);
  assert.deepEqual(computeReadingCalendarRollup([...savedWeeks, close]), computeReadingCalendarRollup(baseline));

  const late = placed('late-sunday', '2026-11-15T10:00:00Z', regularClose).data;
  const recomputed = computeWeeklyReadingRollup([...aligned, late], lastBackfillWeek);
  assert.notDeepEqual(savedWeeks.at(-1), recomputed, 'a late record in a draft week needs local recomputation before publication');
});
