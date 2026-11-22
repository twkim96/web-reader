import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { APP_ID } from '../src/lib/appIdentity.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';
import { computeReadingCalendarRollup, computeWeeklyReadingRollup } from '../src/lib/readingStatisticsRollup.ts';
import { addReadingRollupPage, createReadingRollupCarry } from '../src/server/readingRollupInputs.ts';
import {
  claimReadingRollup, releaseReadingRollup, reserveReadingRollupReads, runReadingRollupCron, stageReadingRollupHandoff,
} from '../src/server/readingRollupStore.ts';

assert.ok(process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
const app = initializeApp({ projectId: 'demo-web-reader' }, 'reading-rollup-test');
const db = getFirestore(app);
after(() => deleteApp(app));

const root = `artifacts/${APP_ID}`;
const jobRef = (uid) => db.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
const sourceRef = (uid, id) => db.doc(`${root}/users/${uid}/libraries/local/readingStatsV1/${id}`);
const quotaRef = (date) => db.doc(`${root}/readingStatsRollupBudgetsV1/${date}`);
const weekMs = 7 * 86_400_000;
const first = Date.parse('2026-09-14');
const weekStarts = Array.from({ length: 10 }, (_, i) => new Date(first + i * weekMs).toISOString().slice(0, 10));
const nextWeek = weekStarts.at(-1);

test('the scheduled route requires both enablement and the Cron secret', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return next(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const route = await import('../src/app/api/reading-statistics/rollup/route.ts');
  const { GET } = route.default ?? route;
  const env = process.env;
  const original = { ENABLE_READING_STATS_ROLLUP: env.ENABLE_READING_STATS_ROLLUP, CRON_SECRET: env.CRON_SECRET };
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });
  const request = (secret) => new Request('http://localhost/api/reading-statistics/rollup', {
    headers: { authorization: `Bearer ${secret}` },
  });
  env.ENABLE_READING_STATS_ROLLUP = '0';
  env.CRON_SECRET = 'rollup-fixture-secret';
  assert.equal((await GET(request(env.CRON_SECRET))).status, 404);
  env.ENABLE_READING_STATS_ROLLUP = '1';
  assert.equal((await GET(request('rollup-unknown-secret'))).status, 401);
  const response = await GET(request(env.CRON_SECRET));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

function session(sessionId, started, fields = {}) {
  const startedAtClient = Date.parse(started);
  return {
    schemaVersion: 1, sessionId, bookId: 'book', bookTitle: 'Book', deviceId: 'device', mode: 'screen',
    startedAtClient, endedAtClient: startedAtClient + 180_000, durationMs: 180_000,
    startProgressPercent: 10, endProgressPercent: 12, timezoneOffsetMinutes: 0,
    localDate: getReadingSessionLocalDate(startedAtClient, 0), completed: false, ...fields,
  };
}

test('Mac and Cron contend for an account lease and share the Pacific-day source quota', async () => {
  let time = Date.parse('2026-12-10T10:00:00Z');
  const now = () => time;
  const [left, right] = await Promise.all([
    claimReadingRollup(db, 'budget-shared-account', now), claimReadingRollup(db, 'budget-shared-account', now),
  ]);
  assert.ok(Boolean(left) !== Boolean(right));
  const firstLease = left ?? right;
  const other = await claimReadingRollup(db, 'budget-other-account', now);
  await quotaRef('2026-12-10').set({ sourceReads: 1850 });
  assert.equal(await reserveReadingRollupReads(db, firstLease, 100, now), 100);
  assert.equal(await reserveReadingRollupReads(db, other, 100, now), 50);
  assert.equal(await reserveReadingRollupReads(db, other, 1, now), 0);

  time = Date.parse('2026-12-11T07:57:00Z');
  const renewed = await claimReadingRollup(db, firstLease.uid, now);
  await assert.rejects(reserveReadingRollupReads(db, firstLease, 10, now), /lease lost/);
  await releaseReadingRollup(db, firstLease);
  assert.equal(await reserveReadingRollupReads(db, renewed, 10, now), 0);
  time = Date.parse('2026-12-11T08:01:00Z');
  assert.equal(await reserveReadingRollupReads(db, renewed, 10, now), 10);
  assert.equal((await quotaRef('2026-12-11').get()).get('sourceReads'), 10);
  await releaseReadingRollup(db, renewed);
  await releaseReadingRollup(db, other);
});

test('a budget pause keeps the source cursor and exposes the first calendar only with all ten weeks', async () => {
  const uid = 'weekly-pilot-fixture';
  const sourceCutoff = Timestamp.fromDate(new Date('2026-11-23T12:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const firstRead = session('old-session', '2026-09-14T09:00:00Z');
  const across = session('across-week', '2026-11-15T23:58:00Z', {
    clockOffsetMs: 60_000, clockUncertaintyMs: 0, clockMeasuredAtClient: Date.parse('2026-11-15T23:58:00Z'),
  });
  const staged = [across, firstRead];
  const oldWeeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup(staged, week));
  const seed = { weeks: oldWeeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry(staged, nextWeek), pilotTuesday: true };
  const lease = await claimReadingRollup(db, uid, now);
  await assert.rejects(stageReadingRollupHandoff(db, lease, { ...seed, weeks: oldWeeks.slice(1) }, now), /10 consecutive/);
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'staged');
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'already-staged');
  await releaseReadingRollup(db, lease);

  const job = jobRef(uid);
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  const weeks = job.collection('readingStatsRollupWeeksV1');
  const calendar = job.collection('readingStatsRollupCalendarsV1').doc(nextWeek);
  assert.equal((await manifest.get()).exists, false);
  const early = session('a', '2026-11-16T00:03:00Z');
  const later = session('b', '2026-11-16T01:00:00Z');
  const late = session('previous-week-late', '2026-11-12T00:00:00Z');
  const stamp = Timestamp.fromDate(new Date('2026-11-23T16:00:00Z'));
  await Promise.all([
    // This row would stop the close if the scheduled path scanned old history.
    sourceRef(uid, 'old-session').set({ uploadedAtServer: Timestamp.fromMillis(first) }),
    sourceRef(uid, across.sessionId).set({ ...across, uploadedAtServer: Timestamp.fromMillis(time - 60_000) }),
    sourceRef(uid, 'a').set({ ...early, uploadedAtServer: stamp }),
    sourceRef(uid, 'b').set({ ...later, uploadedAtServer: stamp }),
    sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: stamp }),
    sourceRef(uid, 'next-cutoff').set({ uploadedAtServer: Timestamp.fromMillis(Date.parse('2026-11-24T09:01:00Z')) }),
  ]);
  time = Date.parse('2026-11-24T08:59:59Z');
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 1999 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  const checkpoint = JSON.parse((await job.get()).get('payload'));
  assert.equal(checkpoint.cursor.id, across.sessionId);
  assert.equal((await manifest.get()).exists, false);
  assert.equal((await weeks.doc(nextWeek).get()).exists, false);
  assert.equal((await calendar.get()).exists, false);

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  const result = (await manifest.get()).data();
  assert.equal(result.firstWeek, weekStarts[0]);
  assert.equal(result.publishedThroughWeek, nextWeek);
  assert.equal(result.lastCalendarWeek, nextWeek);
  assert.equal(result.sourceThrough.toMillis(), Date.parse('2026-11-24T09:00:00Z'));
  const expected = computeWeeklyReadingRollup([early, across, later, firstRead], nextWeek);
  assert.equal(expected.days[0].totalMs, 480_000);
  assert.deepEqual(JSON.parse((await weeks.doc(nextWeek).get()).get('payload')), expected);
  assert.deepEqual(JSON.parse((await calendar.get()).get('payload')), computeReadingCalendarRollup([...oldWeeks, expected]));
  assert.deepEqual(JSON.parse((await weeks.doc(weekStarts[8]).get()).get('payload')), oldWeeks[8]);
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});

  time = Date.parse('2026-12-01T09:10:00Z');
  assert.deepEqual(await runReadingRollupCron(db, { now }), { blocked: 1 });
  assert.equal((await job.get()).get('blocked'), 'invalid-source-session');
  assert.equal((await manifest.get()).get('publishedThroughWeek'), nextWeek);
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
});

test('carry rejects an input that would need clock samples it no longer holds', () => {
  const carry = createReadingRollupCarry([], nextWeek);
  const early = '2026-11-01T00:00:00Z';
  const resumed = Date.parse('2026-11-16T10:00:00Z');
  const tts = session('late-tts', early, {
    mode: 'tts', endedAtClient: resumed + 120_000,
    activeIntervals: [
      { startedAtClient: Date.parse(early), endedAtClient: Date.parse(early) + 60_000 },
      { startedAtClient: resumed, endedAtClient: resumed + 120_000 },
    ],
  });
  assert.throws(() => addReadingRollupPage(carry, [tts], nextWeek), /older than the saved input/);
  assert.deepEqual(addReadingRollupPage(carry, [session('old', early)], nextWeek), carry);
});
