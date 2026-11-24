import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { APP_ID } from '../src/lib/appIdentity.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';
import { latestReadingPublicationCutoff } from '../src/lib/readingRollupBootstrap.ts';
import { computeReadingCalendarRollup, computeWeeklyReadingRollup, mergeReadingFileRollups } from '../src/lib/readingStatisticsRollup.ts';
import { addReadingRollupPage, createReadingRollupCarry, rollupCoversHistoryStart } from '../src/server/readingRollupInputs.ts';
import { readPublishedReadingBootstrap, readPublishedReadingEvidenceInputs, readPublishedReadingFiles, readPublishedReadingReportBooks } from '../src/server/readingRollupRead.ts';
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
  const { getAdminAuth } = await import('../src/server/firebaseAdmin.ts');
  const listAccounts = t.mock.method(getAdminAuth(), 'listUsers', async () => ({ users: [] }));
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
  assert.equal(listAccounts.mock.callCount(), 1);
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

test('rollup writers share an account lease and Cron reservations share the Pacific-day quota', async () => {
  let time = Date.parse('2026-12-10T10:00:00Z');
  const now = () => time;
  const [left, right] = await Promise.all([
    claimReadingRollup(db, 'budget-shared-account', now), claimReadingRollup(db, 'budget-shared-account', now),
  ]);
  assert.ok(Boolean(left) !== Boolean(right));
  const firstLease = left ?? right;
  const other = await claimReadingRollup(db, 'budget-other-account', now);
  await quotaRef('2026-12-10').set({ sourceReads: 3_850 });
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

test('Cron enrolls an account with reading history and resumes its private initial scan without a client visit', async (t) => {
  const enrollmentApp = initializeApp({ projectId: 'demo-web-reader-rollup-enrollment' }, 'rollup-enrollment-test');
  t.after(() => deleteApp(enrollmentApp));
  const store = getFirestore(enrollmentApp);
  const uid = 'account.with-history';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const existing = store.doc(`${root}/readingStatsRollupJobsV1/already-registered`);
  const reading = store.collection(`${root}/users/${uid}/libraries/local/readingStatsV1`);
  const chunks = job.collection('readingStatsRollupBootstrapChunksV1');
  const weekDetails = job.collection('readingStatsRollupWeeksV1');
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  const day = 86_400_000;
  const cutoff = latestReadingPublicationCutoff(Date.now());
  const closeWeek = cutoff - 8 * day - 9 * 3_600_000;
  const date = (ms) => new Date(ms).toISOString().slice(0, 10);
  const recent = session('c-modern', new Date(closeWeek + 2 * day).toISOString());
  const legacy = session('b-legacy', new Date(closeWeek - 3 * day).toISOString());
  const late = session('a-uploaded-during-scan', new Date(closeWeek + 9 * day).toISOString());
  const pacific = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
  let time = Math.max(Date.now(), cutoff) + day;
  const now = () => time;
  await Promise.all([
    reading.doc(legacy.sessionId).create(legacy),
    reading.doc(recent.sessionId).create({ ...recent, uploadedAtServer: FieldValue.serverTimestamp() }),
    existing.create({ dueAt: time + 30 * day, payload: 'original-pilot-job' }),
  ]);
  const pages = [];
  const listAccounts = async (limit, pageToken) => {
    pages.push(pageToken);
    assert.ok(limit <= 20);
    return pageToken
      ? { users: [{ uid: 'empty-account', disabled: false }] }
      : { users: [{ uid, disabled: false }, { uid: existing.id, disabled: false }], pageToken: 'next-page' };
  };
  assert.deepEqual(await runReadingRollupCron(store, { now, listAccounts }), { enrolled: 1 });
  assert.equal((await existing.get()).get('payload'), 'original-pilot-job');
  assert.equal((await job.get()).get('dueAt'), undefined);
  assert.equal((await manifest.get()).exists, false);

  const budget = store.doc(`${root}/readingStatsRollupBudgetsV1/${pacific.format(time)}`);
  await budget.set({ sourceReads: 3_999 });
  assert.deepEqual(await runReadingRollupCron(store, { now, listAccounts }), { budget: 1 });
  const firstScan = (await job.get()).get('bootstrap');
  assert.equal(firstScan.cursor, legacy.sessionId);
  assert.equal((await chunks.get()).size, 1);
  await reading.doc(late.sessionId).create({ ...late, uploadedAtServer: FieldValue.serverTimestamp() });

  time += day;
  assert.deepEqual(await runReadingRollupCron(store, { now, listAccounts }), { prepared: 1 });
  assert.deepEqual(pages, [undefined, 'next-page']);
  assert.equal((await store.doc(`${root}/readingStatsRollupJobsV1/empty-account`).get()).exists, false);
  assert.equal((await manifest.get()).exists, false);
  assert.deepEqual(JSON.parse((await weekDetails.doc(date(closeWeek - weekMs)).get()).get('payload')).days
    .map(({ localDate, totalMs }) => [localDate, totalMs]), [[legacy.localDate, legacy.durationMs]]);

  time += day;
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  const published = await readPublishedReadingBootstrap(store, uid);
  assert.ok(published);
  assert.equal(published.calendar.lastDay, date(closeWeek + 6 * day));
  assert.deepEqual(published.calendar.days.map(({ localDate }) => localDate).sort(), [legacy.localDate, recent.localDate]);
  assert.equal((await chunks.get()).empty, true);

  time = Math.max(time, cutoff + weekMs + 3_600_000);
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  const next = JSON.parse((await weekDetails.doc(date(closeWeek + weekMs)).get()).get('payload'));
  assert.deepEqual(next.days.map(({ localDate, totalMs }) => [localDate, totalMs]), [[late.localDate, late.durationMs]]);
});

test('an automatic handoff leaves the still-open previous week available for uploads before Tuesday cutoff', async (t) => {
  const enrollmentApp = initializeApp({ projectId: 'demo-web-reader-rollup-cutoff' }, 'rollup-enrollment-cutoff');
  t.after(() => deleteApp(enrollmentApp));
  const store = getFirestore(enrollmentApp);
  const uid = 'first-read-near-cutoff';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const reading = store.collection(`${root}/users/${uid}/libraries/local/readingStatsV1`);
  const latest = session('current-week-first-read', '2026-10-13T08:50:00Z');
  const late = session('previous-sunday-uploaded-before-cutoff', '2026-10-11T18:00:00Z');
  let time = Date.parse('2026-10-13T08:55:00Z');
  const now = () => time;
  const payload = JSON.stringify([latest]);
  await Promise.all([
    job.create({ bootstrapDueAt: time, bootstrap: { cutoff: Timestamp.fromMillis(time), cursor: latest.sessionId,
      chunks: 1, bytes: Buffer.byteLength(payload), scanned: true } }),
    job.collection('readingStatsRollupBootstrapChunksV1').doc('0').create({ payload }),
    reading.doc(latest.sessionId).create({ ...latest, uploadedAtServer: Timestamp.fromMillis(time - 1) }),
  ]);

  assert.deepEqual(await runReadingRollupCron(store, { now }), { prepared: 1 });
  const week = job.collection('readingStatsRollupWeeksV1').doc('2026-10-05');
  assert.equal((await week.get()).exists, false);
  await reading.doc(late.sessionId).create({ ...late, uploadedAtServer: Timestamp.fromDate(new Date('2026-10-13T08:58:00Z')) });
  time = Date.parse('2026-10-13T09:00:00Z');
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  assert.deepEqual(JSON.parse((await week.get()).get('payload')).days.map(({ localDate, totalMs }) => [localDate, totalMs]),
    [[late.localDate, late.durationMs]]);
});

test('an oversized initial page checkpoints only the committed source prefix', async (t) => {
  const enrollmentApp = initializeApp({ projectId: 'demo-web-reader-rollup-large-page' }, 'rollup-large-page-test');
  t.after(() => deleteApp(enrollmentApp));
  const store = getFirestore(enrollmentApp);
  const uid = 'large-imported-history';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const reading = store.collection(`${root}/users/${uid}/libraries/local/readingStatsV1`);
  const pacific = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
  const time = Date.parse('2026-11-25T09:05:00Z');
  const now = () => time;
  const fixture = Array.from({ length: 18 }, (_, index) => {
    const entry = session(`imported-${String(index).padStart(2, '0')}`, '2026-11-18T09:00:00Z', { mode: 'tts' });
    // Older Admin imports can retain extra fields in valid interval records.
    return { ...entry, activeIntervals: [{ startedAtClient: entry.startedAtClient, endedAtClient: entry.endedAtClient,
      importMetadata: 'x'.repeat(480 * 1024) }] };
  });
  await Promise.all(fixture.map((entry) => reading.doc(entry.sessionId).create(entry)));
  await job.create({ bootstrapDueAt: time, bootstrap: { cutoff: null, cursor: null, chunks: 0, bytes: 0, scanned: false } });
  await store.doc(`${root}/readingStatsRollupBudgetsV1/${pacific.format(time)}`).set({ sourceReads: 3_900 });

  assert.deepEqual(await runReadingRollupCron(store, { now }), { budget: 1 });
  const progress = (await job.get()).get('bootstrap');
  const staged = (await job.collection('readingStatsRollupBootstrapChunksV1').get()).docs
    .flatMap((doc) => JSON.parse(doc.get('payload')).map(({ sessionId }) => sessionId)).sort();
  assert.ok(staged.length > 0 && staged.length < fixture.length);
  assert.deepEqual(staged, fixture.slice(0, staged.length).map(({ sessionId }) => sessionId));
  assert.equal(progress.cursor, staged.at(-1));
  assert.equal(progress.scanned, false);
});

test('same-week accounts become due together and exhausted Cron budget defers the rest in queue order', async () => {
  const closeWeek = '2026-07-13';
  const closesAt = Date.parse('2026-07-21T09:00:00Z');
  let time = closesAt - 1;
  const now = () => time;
  const seed = {
    weeks: Array.from({ length: 9 }, (_, i) => computeWeeklyReadingRollup([],
      new Date(Date.parse(closeWeek) - (9 - i) * weekMs).toISOString().slice(0, 10))),
    nextWeek: closeWeek, sourceCutoff: Timestamp.fromMillis(time - 86_400_000), carry: createReadingRollupCarry([], closeWeek),
  };
  const accounts = ['queue-alpha', 'queue-bravo', 'queue-pilot'];
  for (const uid of accounts) {
    const lease = await claimReadingRollup(db, uid, now);
    await stageReadingRollupHandoff(db, lease, { ...seed, pilotTuesday: uid === 'queue-pilot' }, now);
    await releaseReadingRollup(db, lease);
  }
  const queue = await db.collection(`${root}/readingStatsRollupJobsV1`)
    .where('dueAt', '>', time).where('dueAt', '<=', closesAt).orderBy('dueAt').get();
  assert.equal(queue.size, 3);
  const [pilot, first, second] = queue.docs;
  assert.equal(pilot.id, 'queue-pilot');
  assert.notEqual(first.get('dueAt'), second.get('dueAt'));
  assert.ok(queue.docs.every(doc => JSON.parse(doc.get('payload')).closeAt[0] === closesAt / 1000));
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});

  const published = (doc) => doc.ref.collection('readingStatsRollupManifestsV1').doc('current').get();
  time = closesAt;
  await quotaRef('2026-07-21').set({ sourceReads: 3_900 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1, budget: 1 });
  assert.equal((await published(pilot)).exists, true);
  assert.equal((await published(first)).exists, false);
  assert.equal((await published(second)).exists, false);

  time += 86_400_000;
  await quotaRef('2026-07-22').set({ sourceReads: 3_900 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1, budget: 1 });
  assert.equal((await published(first)).exists, true);
  assert.equal((await published(second)).exists, false);
  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  assert.equal((await published(second)).get('sourceThrough').toMillis(), closesAt);
  // The fixture's next weeks are outside the scope of the remaining tests.
  await Promise.all(queue.docs.map(({ ref }) => ref.delete()));
});

test('a budget pause keeps the source cursor and exposes the first calendar only with all ten weeks', async () => {
  const uid = 'weekly-pilot-fixture';
  const sourceCutoff = Timestamp.fromDate(new Date('2026-11-23T12:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const firstRead = session('old-session', '2026-09-16T09:00:00Z');
  const across = session('across-week', '2026-11-15T23:58:00Z', {
    clockOffsetMs: 60_000, clockUncertaintyMs: 0, clockMeasuredAtClient: Date.parse('2026-11-15T23:58:00Z'),
  });
  const staged = [across, firstRead];
  const oldWeeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup(staged, week));
  const coversHistoryStart = rollupCoversHistoryStart(staged, weekStarts[0]);
  assert.equal(coversHistoryStart, true);
  const seed = { weeks: oldWeeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry(staged, nextWeek),
    pilotTuesday: true, coversHistoryStart, evidenceCompatible: true };
  const lease = await claimReadingRollup(db, uid, now);
  await assert.rejects(stageReadingRollupHandoff(db, lease, { ...seed, weeks: oldWeeks.slice(1) }, now), /10 consecutive/);
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'staged');
  const filesRef = jobRef(uid).collection('readingStatsRollupFilesV1').doc('current');
  await filesRef.delete();
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'already-staged');
  assert.equal((await filesRef.get()).get('throughWeek'), weekStarts[8]);
  assert.equal(await stageReadingRollupHandoff(db, lease, { ...seed, coversHistoryStart: undefined }, now), 'already-staged');
  await releaseReadingRollup(db, lease);

  const job = jobRef(uid);
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  const weeks = job.collection('readingStatsRollupWeeksV1');
  const calendar = job.collection('readingStatsRollupCalendarsV1').doc(nextWeek);
  assert.equal((await manifest.get()).exists, false);
  assert.equal(await readPublishedReadingFiles(db, uid), null);
  assert.equal(await readPublishedReadingReportBooks(db, uid), null);
  const early = session('a', '2026-11-16T00:03:00Z');
  const later = session('b', '2026-11-16T01:00:00Z');
  const late = session('previous-week-late', '2026-11-15T10:00:00Z');
  const beforeFirstWeek = session('before-first-week', '2026-09-13T09:00:00Z');
  const stamp = Timestamp.fromDate(new Date('2026-11-23T16:00:00Z'));
  await Promise.all([
    // This row would stop the close if the scheduled path scanned old history.
    sourceRef(uid, 'old-session').set({ uploadedAtServer: Timestamp.fromMillis(first) }),
    sourceRef(uid, across.sessionId).set({ ...across, uploadedAtServer: Timestamp.fromMillis(time - 60_000) }),
    sourceRef(uid, 'a').set({ ...early, uploadedAtServer: stamp }),
    sourceRef(uid, 'b').set({ ...later, uploadedAtServer: stamp }),
    sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: stamp }),
    sourceRef(uid, beforeFirstWeek.sessionId).set({ ...beforeFirstWeek, uploadedAtServer: stamp }),
    sourceRef(uid, 'next-cutoff').set({ uploadedAtServer: Timestamp.fromMillis(Date.parse('2026-11-24T09:01:00Z')) }),
  ]);
  time = Date.parse('2026-11-24T08:59:59Z');
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 3_999 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  const checkpoint = JSON.parse((await job.get()).get('payload'));
  assert.equal(checkpoint.cursor.id, across.sessionId);
  assert.equal((await manifest.get()).exists, false);
  assert.equal((await weeks.doc(nextWeek).get()).exists, false);
  assert.equal((await calendar.get()).exists, false);
  assert.equal(await readPublishedReadingFiles(db, uid), null);

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  const result = (await manifest.get()).data();
  assert.equal(result.firstWeek, weekStarts[0]);
  assert.equal(result.publishedThroughWeek, nextWeek);
  assert.equal(result.lastCalendarWeek, nextWeek);
  assert.equal(result.coversHistoryStart, false, 'a late session before the first week revokes the coverage proof');
  assert.equal(result.sourceThrough.toMillis(), Date.parse('2026-11-24T09:00:00Z'));
  const expected = computeWeeklyReadingRollup([early, across, later, firstRead], nextWeek);
  assert.equal(expected.days[0].totalMs, 480_000);
  assert.deepEqual(JSON.parse((await weeks.doc(nextWeek).get()).get('payload')), expected);
  assert.deepEqual(JSON.parse((await calendar.get()).get('payload')), computeReadingCalendarRollup([...oldWeeks, expected]));
  assert.deepEqual(await readPublishedReadingFiles(db, uid), {
    firstDay: weekStarts[0], lastDay: '2026-11-22',
    files: mergeReadingFileRollups(...oldWeeks.map(({ files }) => files), expected.files),
  });
  assert.equal(JSON.parse((await filesRef.get()).get('payload')).carry, undefined);
  const { books } = await readPublishedReadingReportBooks(db, uid);
  const totalMs = [...oldWeeks, expected].flatMap(({ days }) => days).reduce((sum, day) => sum + day.totalMs, 0);
  assert.equal(books.length, 1);
  assert.deepEqual({ bookId: books[0].bookId, screenMs: books[0].screenMs, ttsMs: books[0].ttsMs },
    { bookId: 'book', screenMs: totalMs, ttsMs: 0 });
  assert.equal(JSON.parse((await job.get()).get('payload')).evidenceCompatible, false);
  assert.deepEqual(JSON.parse((await weeks.doc(weekStarts[8]).get()).get('payload')), oldWeeks[8]);
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});

  time = Date.parse('2026-12-01T09:10:00Z');
  assert.deepEqual(await runReadingRollupCron(db, { now }), { blocked: 1 });
  assert.equal((await job.get()).get('blocked'), 'invalid-source-session');
  assert.equal((await manifest.get()).get('publishedThroughWeek'), nextWeek);
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
});

test('normal one-minute TTS survives the legacy checkpoint size limit and resumes without rereading pages', async (t) => {
  const uid = 'weekly-tts-large-carry';
  const job = jobRef(uid);
  t.after(() => job.delete());
  const openWeek = '2026-06-08';
  const followingWeek = '2026-06-15';
  const sourceCutoff = Timestamp.fromDate(new Date('2026-06-15T08:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const frozen = session('frozen-sunday', '2026-06-07T12:00:00Z');
  const oldWeeks = Array.from({ length: 9 }, (_, i) => computeWeeklyReadingRollup([frozen],
    new Date(Date.parse(openWeek) - (9 - i) * weekMs).toISOString().slice(0, 10)));
  const seed = { weeks: oldWeeks, nextWeek: openWeek, sourceCutoff,
    carry: createReadingRollupCarry([frozen], openWeek), pilotTuesday: true, coversHistoryStart: true };
  const lease = await claimReadingRollup(db, uid, now);
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'staged');
  await releaseReadingRollup(db, lease);

  const tts = Array.from({ length: 980 + 24 }, (_, i) => {
    const startedAtClient = Date.parse(openWeek) + Math.floor(i / 140) * 86_400_000 + 9 * 3_600_000 + (i % 140) * 60_000;
    const endedAtClient = startedAtClient + 60_000;
    return session(randomUUID(), new Date(startedAtClient).toISOString(), {
      bookId: 'drive-fiction-identifier-2026-06-volume-01', bookTitle: '별빛 도서관의 여행 1권',
      deviceId: 'fa7aa6cb-09ce-457f-b7d8-4d8993953e07', mode: 'tts', endedAtClient, durationMs: 60_000,
      activeIntervals: [{ startedAtClient, endedAtClient }],
      clockMeasuredAtClient: startedAtClient - 1_000, clockOffsetMs: 0, clockUncertaintyMs: 100,
    });
  }).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const uploadedAtServer = new Timestamp(sourceCutoff.seconds + 86_400, 123_000);
  for (let i = 0; i < tts.length; i += 400) {
    const batch = db.batch();
    for (const row of tts.slice(i, i + 400)) batch.set(sourceRef(uid, row.sessionId), { ...row, uploadedAtServer });
    await batch.commit();
  }

  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  const detail = job.collection('readingStatsRollupWeeksV1').doc(openWeek);
  const dueAt = (await job.get()).get('dueAt');
  time = Date.parse('2026-06-16T09:10:00Z');
  await quotaRef('2026-06-16').set({ sourceReads: 3_300 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  const legacy = JSON.parse((await job.get()).get('payload'));
  assert.equal(legacy.cursor.id, tts[699].sessionId);
  assert.deepEqual(legacy.carry.sessions, [frozen, ...tts.slice(0, 700)]);
  // A size-blocked job retains its last successful checkpoint. Requeue only its metadata.
  await job.update({ blocked: 'rollup-payload-too-large', dueAt: FieldValue.delete() });
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
  await job.update({ blocked: FieldValue.delete(), dueAt });

  time += 86_400_000;
  await quotaRef('2026-06-17').set({ sourceReads: 3_740 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  const saved = (await job.get()).get('payload');
  const checkpoint = JSON.parse(saved);
  assert.equal(checkpoint.cursor.id, tts[959].sessionId);
  assert.deepEqual(checkpoint.cursor.time, [uploadedAtServer.seconds, uploadedAtServer.nanoseconds]);
  assert.deepEqual(checkpoint.closedAllocation, legacy.closedAllocation);
  assert.equal(checkpoint.carry.encoding, 'gzip-v1');
  const carry = JSON.parse(gunzipSync(Buffer.from(checkpoint.carry.data, 'base64')).toString('utf8'));
  assert.deepEqual(carry, { sampleFloor: legacy.carry.sampleFloor, sessions: [frozen, ...tts.slice(0, 960)] });
  assert.ok(Buffer.byteLength(JSON.stringify({ ...checkpoint, carry })) > 512 * 1024);
  assert.ok(Buffer.byteLength(saved) <= 512 * 1024);
  assert.equal((await manifest.get()).exists, false);
  assert.equal((await detail.get()).exists, false);
  const retryLease = await claimReadingRollup(db, uid, now);
  assert.equal(await stageReadingRollupHandoff(db, retryLease, seed, now), 'already-staged');
  await releaseReadingRollup(db, retryLease);
  assert.equal((await job.get()).get('payload'), saved);

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  assert.equal((await quotaRef('2026-06-18').get()).get('sourceReads'), 100);
  const expected = computeWeeklyReadingRollup([frozen, ...tts], openWeek);
  assert.equal(expected.days.reduce((sum, day) => sum + day.ttsMs, 0), 980 * 60_000);
  assert.deepEqual(JSON.parse((await detail.get()).get('payload')), expected);
  assert.equal((await manifest.get()).get('publishedThroughWeek'), openWeek);
  const nextCarry = createReadingRollupCarry([frozen, ...tts], followingWeek);
  assert.deepEqual(JSON.parse((await job.get()).get('payload')).carry, nextCarry);
  const files = job.collection('readingStatsRollupFilesV1').doc('current');
  assert.deepEqual(JSON.parse((await files.get()).get('payload')).carry, nextCarry);
});

test('late records can use a clock sample on a later page after a budget pause', async () => {
  const uid = 'weekly-late-clock-resume';
  const sourceCutoff = Timestamp.fromDate(new Date('2026-11-23T08:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const frozen = session('z-frozen', '2026-11-15T12:00:00Z', { deviceId: 'other-device' });
  const late = session('late-sunday', '2026-11-15T14:00:00Z', { timezoneOffsetMinutes: -540 });
  const monday = session('monday-clock', '2026-11-16T01:00:00Z', {
    timezoneOffsetMinutes: -540, clockOffsetMs: 500, clockUncertaintyMs: 0,
    clockMeasuredAtClient: Date.parse('2026-11-16T01:00:00Z'),
  });
  const weeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup([frozen], week));
  const lease = await claimReadingRollup(db, uid, now);
  await stageReadingRollupHandoff(db, lease, {
    weeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry([frozen], nextWeek), pilotTuesday: true,
  }, now);
  await releaseReadingRollup(db, lease);
  await Promise.all([
    sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: Timestamp.fromMillis(time + 60_000) }),
    sourceRef(uid, monday.sessionId).set({ ...monday, uploadedAtServer: Timestamp.fromMillis(time + 120_000) }),
  ]);

  const job = jobRef(uid);
  const details = job.collection('readingStatsRollupWeeksV1');
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 3_999 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  assert.equal(JSON.parse((await job.get()).get('payload')).cursor.id, late.sessionId);
  assert.equal((await manifest.get()).exists, false);

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  assert.equal((await manifest.get()).get('publishedThroughWeek'), nextWeek);
  assert.deepEqual(JSON.parse((await details.doc(nextWeek).get()).get('payload')),
    computeWeeklyReadingRollup([frozen, late, monday], nextWeek));
  assert.deepEqual(JSON.parse((await details.doc(weekStarts[8]).get()).get('payload')), weeks[8]);
});

test('the first close preserves frozen week slices against late clock readings and overlapping TTS', async () => {
  const sourceCutoff = Timestamp.fromDate(new Date('2026-11-23T08:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const measuredAt = Date.parse('2026-11-16T00:01:00Z');
  const midnight = Date.parse('2026-11-16T00:00:00Z');
  const cases = [
    {
      uid: 'changed-clock-seam',
      old: session('sunday', '2026-11-15T23:57:00Z'),
      late: session('new-clock', '2026-11-16T00:01:00Z', {
        endedAtClient: measuredAt + 60_000, durationMs: 60_000, bookId: 'sample',
        clockOffsetMs: 120_000, clockUncertaintyMs: 0, clockMeasuredAtClient: measuredAt,
      }),
    },
    {
      uid: 'changed-tts-seam',
      old: session('sunday-other-timezone', '2026-11-16T00:00:00Z', {
        timezoneOffsetMinutes: 60, localDate: '2026-11-15',
        clockOffsetMs: 0, clockUncertaintyMs: 0, clockMeasuredAtClient: midnight,
      }),
      late: session('new-tts', '2026-11-16T00:00:00Z', {
        deviceId: 'other-device', mode: 'tts',
        clockOffsetMs: 0, clockUncertaintyMs: 0, clockMeasuredAtClient: midnight,
      }),
    },
  ];
  for (const { uid, old, late } of cases) {
    const weeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup([old], week));
    assert.equal(weeks.at(-1).days[0].totalMs, 180_000);
    assert.ok(computeWeeklyReadingRollup([old, late], nextWeek).days[0].totalMs > 0);
    assert.equal(computeWeeklyReadingRollup([old, late], weekStarts[8]).days.length, 0);
    const lease = await claimReadingRollup(db, uid, now);
    await stageReadingRollupHandoff(db, lease, {
      weeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry([old], nextWeek), pilotTuesday: true,
    }, now);
    await releaseReadingRollup(db, lease);
    await sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: Timestamp.fromMillis(time + 60_000) });
  }

  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 0 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { blocked: 2 });
  for (const { uid } of cases) {
    const job = jobRef(uid);
    assert.equal((await job.get()).get('blocked'), 'changed-closed-week-allocation');
    assert.equal((await job.get()).get('dueAt'), undefined);
    const weeks = job.collection('readingStatsRollupWeeksV1');
    assert.equal(JSON.parse((await weeks.doc(weekStarts[8]).get()).get('payload')).days[0].totalMs, 180_000);
    assert.equal((await weeks.doc(nextWeek).get()).exists, false);
    assert.equal((await job.collection('readingStatsRollupManifestsV1').doc('current').get()).exists, false);
  }
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

test('the first close publishes a backfilled calendar block and the regular block without granting legacy review compatibility', async () => {
  const uid = 'legacy-carry-publication';
  const sourceCutoff = Timestamp.fromMillis(Date.parse('2026-11-23T12:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const legacy = session('legacy', '2026-09-16T09:00:00Z', { completed: true, completionRoundNumber: 1,
    completionConfirmedAtClient: Date.parse('2026-09-16T09:03:00Z') });
  const oldest = session('older-than-nine-weeks', '2026-08-10T09:00:00Z');
  const candidates = Array.from({ length: 19 }, (_, i) => {
    const start = new Date(first + (i - 10) * weekMs).toISOString().slice(0, 10);
    return computeWeeklyReadingRollup([oldest, legacy], start);
  });
  const lease = await claimReadingRollup(db, uid, now);
  const seed = { weeks: candidates, nextWeek, sourceCutoff,
    carry: createReadingRollupCarry([oldest, legacy], nextWeek), pilotTuesday: true,
    coversHistoryStart: rollupCoversHistoryStart([oldest, legacy], candidates[0].weekStart) };
  await assert.rejects(stageReadingRollupHandoff(db, lease, { ...seed, weeks: candidates.slice(1) }, now), /10 consecutive/);
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'staged');
  assert.equal(await stageReadingRollupHandoff(db, lease, seed, now), 'already-staged');
  await releaseReadingRollup(db, lease);
  const job = jobRef(uid);
  const calendars = job.collection('readingStatsRollupCalendarsV1');
  const earlier = await calendars.doc(candidates[9].weekStart).get();
  assert.deepEqual(JSON.parse(earlier.get('payload')), computeReadingCalendarRollup(candidates.slice(0, 10)));
  assert.equal(await readPublishedReadingBootstrap(db, uid), null);
  assert.equal((await calendars.doc(nextWeek).get()).exists, false);

  time = Date.parse('2026-11-26T09:10:00Z');
  assert.equal((await runReadingRollupCron(db, { now })).published, 1);
  assert.equal((await calendars.doc(nextWeek).get()).exists, true);
  const bootstrap = await readPublishedReadingBootstrap(db, uid);
  assert.equal(bootstrap.calendar.firstDay, candidates[0].weekStart);
  assert.equal(bootstrap.calendar.lastDay, '2026-11-22');
  assert.deepEqual(bootstrap.calendar.days.map(({ localDate, totalMs }) => [localDate, totalMs]), [['2026-08-10', 180_000]]);
  assert.equal(bootstrap.books[0].screenMs, 180_000);
  const ref = job.collection('readingStatsRollupFilesV1').doc('current');
  const payload = JSON.parse((await ref.get()).get('payload'));
  assert.ok(payload.carry);
  assert.equal(payload.evidenceCompatible, false);
  assert.equal(await readPublishedReadingEvidenceInputs(db, uid), null);
  delete payload.evidenceCompatible;
  await ref.update({ payload: JSON.stringify(payload) });
  assert.ok(await readPublishedReadingEvidenceInputs(db, uid), 'older carry payloads remain compatible');
  payload.evidenceCompatible = true;
  await ref.update({ payload: JSON.stringify(payload) });
  assert.ok(await readPublishedReadingEvidenceInputs(db, uid));
});
