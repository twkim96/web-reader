import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { APP_ID } from '../src/lib/appIdentity.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';
import {
  encodeReadingDayMember, identifyReadingDaySession, parseReadingDayDocument, parseReadingDaySession,
  readingDayPartId, READING_STATISTICS_DAY_MAX_SESSIONS,
} from '../src/lib/readingStatisticsDay.ts';
import { latestReadingPublicationCutoff } from '../src/lib/readingRollupBootstrap.ts';
import { computeReadingCalendarRollup, computeWeeklyReadingRollup, mergeReadingFileRollups } from '../src/lib/readingStatisticsRollup.ts';
import { addReadingRollupPage, createReadingRollupCarry, rollupCoversHistoryStart } from '../src/server/readingRollupInputs.ts';
import { readPublishedReadingBootstrap, readPublishedReadingEvidenceInputs, readPublishedReadingFiles, readPublishedReadingReportBooks } from '../src/server/readingRollupRead.ts';
import {
  claimReadingRollup, releaseReadingRollup, reserveReadingRollupReads, runReadingRollupCron, stageReadingRollupHandoff,
} from '../src/server/readingRollupStore.ts';
import {
  appendReadingDaySession, readingDaySource, readingDayWindowQuery, readReadingDayWindowMemberRows,
} from '../src/server/readingStatisticsDayStore.ts';

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

async function seedDayPart(store, uid, rows) {
  const [{ session: first, received }] = rows;
  const { bucket } = await parseReadingDaySession(first);
  const members = rows.map(({ session: value, received: firstReceivedAt }) =>
    [value.sessionId, { ...encodeReadingDayMember(value), firstReceivedAt }]);
  const ref = readingDaySource(store, uid).doc(readingDayPartId(bucket, 0));
  await ref.set({
    containerVersion: 2, bucket, part: 0, deviceId: first.deviceId, capturedDay: first.localDate,
    firstReceivedAt: received, lastReceivedAt: rows.at(-1).received, hasNext: false, memberCount: members.length,
    bytes: members.reduce((size, [, entry]) => size + entry.bytes, 0),
    intervals: members.reduce((size, [, entry]) => size + entry.intervals, 0),
    members: Object.fromEntries(members.map(([id, { payload, firstReceivedAt }]) => [id, { payload, firstReceivedAt }])),
  });
  return ref;
}

test('device-day appends keep stable identities and a resumable cutoff after a later append', async () => {
  const uid = 'day-session-window';
  const at = '2026-11-22T14:00:00Z';
  const createSession = (deviceId, started = at) => identifyReadingDaySession(session(randomUUID(), started, {
    deviceId, timezoneOffsetMinutes: -540, localDate: getReadingSessionLocalDate(Date.parse(started), -540),
  }));
  const first = await createSession('device-a');
  const second = await createSession('device-b');
  const later = await createSession('device-a');
  const parts = readingDaySource(db, uid);
  const parsed = await parseReadingDaySession(first);
  const firstPart = parts.doc(readingDayPartId(parsed.bucket, 0));
  const append = async (value) => appendReadingDaySession(db, uid, await parseReadingDaySession(value));

  const results = await Promise.all([append(first), append(first)]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['created', 'replayed']);
  const original = (await firstPart.get()).get('firstReceivedAt');
  const modified = { ...first, endProgressPercent: 80 };
  assert.deepEqual(await append(modified), { status: 'conflict', remote: first });
  await assert.rejects(parseReadingDaySession({ ...first, deviceId: 'device-b' }), /Invalid reading day identity/);
  await assert.rejects(parseReadingDaySession({
    ...first, startedAtClient: Date.parse('2026-11-23T14:00:00Z'),
    endedAtClient: Date.parse('2026-11-23T14:03:00Z'), localDate: '2026-11-23',
  }), /Invalid reading day identity/);

  await append(second);
  const cutoff = (await parts.get()).readTime;
  const floor = Timestamp.fromMillis(0);
  const window = readingDayWindowQuery(db, uid, floor, cutoff);
  const page = await window.limit(1).get();
  assert.equal(page.docs[0].id, firstPart.id);
  const cursor = [page.docs[0].get('lastReceivedAt'), page.docs[0].get('firstReceivedAt'), page.docs[0].id];
  await append(later);
  await append(await createSession('device-c'));
  const rest = await window.startAfter(...cursor).get();
  assert.equal(rest.size, 2, 'the mutated part stays visible, but a newly received day is outside the cutoff');
  const entries = [...page.docs, ...rest.docs].flatMap((doc) => readReadingDayWindowMemberRows(doc, floor, cutoff));
  assert.deepEqual([...new Set(entries.map(({ session }) => session.sessionId))].sort(), [first.sessionId, second.sessionId].sort());
  const newPart = await firstPart.get();
  assert.ok(newPart.get('firstReceivedAt').isEqual(original));
  assert.ok(newPart.get('lastReceivedAt') > cutoff);
  assert.deepEqual(readReadingDayWindowMemberRows(newPart, cutoff, newPart.readTime).map(({ session }) => session), [later]);
});

test('a full device-day part spills once and replays from either part without adding data', async () => {
  const uid = 'day-session-spill';
  const make = () => identifyReadingDaySession(session(randomUUID(), '2026-11-22T14:00:00Z'));
  const sessions = await Promise.all(Array.from({ length: READING_STATISTICS_DAY_MAX_SESSIONS }, make));
  const next = await make();
  const parts = readingDaySource(db, uid);
  const start = Timestamp.fromMillis(Date.parse('2026-11-22T16:00:00Z'));
  await seedDayPart(db, uid, sessions.map((session) => ({ session, received: start })));
  const append = async (value) => appendReadingDaySession(db, uid, await parseReadingDaySession(value));
  assert.equal((await append(next)).status, 'created');
  assert.equal((await append(next)).status, 'replayed');
  assert.equal((await append(sessions.at(-1))).status, 'replayed');
  const docs = await parts.get();
  assert.equal(docs.size, 2);
  const rows = docs.docs.map((doc) => parseReadingDayDocument(doc.data(), doc.id)).sort((left, right) => left.part - right.part);
  assert.equal(rows[0].entries.length, READING_STATISTICS_DAY_MAX_SESSIONS);
  assert.ok(rows[0].hasNext);
  assert.deepEqual(rows[1].entries.map(({ session }) => session), [next]);
});

test('Cron enrolls a day-only account and resumes mixed-source publication without admitting late members', async (t) => {
  const mixedApp = initializeApp({ projectId: 'demo-web-reader-rollup-days' }, 'rollup-days-test');
  t.after(() => deleteApp(mixedApp));
  const store = getFirestore(mixedApp);
  const uid = 'day-only-until-legacy-returns';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const captured = await identifyReadingDaySession(session(randomUUID(), '2026-11-22T15:00:00Z'));
  const late = await identifyReadingDaySession(session(randomUUID(), '2026-11-22T16:00:00Z'));
  const legacy = session('returned-v1-record', '2026-11-22T17:00:00Z');
  const received = (at) => Timestamp.fromMillis(Date.parse(at));
  const cutoff = received('2026-11-24T09:00:00Z');
  const firstMember = { session: captured, received: received('2026-11-23T01:00:00Z') };
  await seedDayPart(store, uid, [firstMember]);
  const pacific = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
  let time = Date.parse('2026-11-23T18:00:00Z');
  const now = () => time;
  assert.deepEqual(await runReadingRollupCron(store, { now, listAccounts: async () => ({
    users: [{ uid, disabled: false }],
  }) }), { enrolled: 1 });
  assert.equal((await job.get()).get('bootstrapDueAt'), time);
  // Seed a snapshot taken the day before the deadline to keep the fixture
  // independent of the wall clock of the emulator.
  await job.update({ 'bootstrap.cutoff': Timestamp.fromMillis(time), 'bootstrap.scanned': true });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { prepared: 1 });
  await store.doc(`${root}/users/${uid}/libraries/local/readingStatsV1/${legacy.sessionId}`).set({
    ...legacy, uploadedAtServer: received('2026-11-24T08:59:59Z'),
  });
  const lateMember = { session: late, received: received('2026-11-24T09:00:01Z') };
  await seedDayPart(store, uid, [firstMember, lateMember]);
  time = cutoff.toMillis();
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  const archive = await readPublishedReadingBootstrap(store, uid);
  const expected = computeWeeklyReadingRollup([captured, legacy], '2026-11-16');
  assert.deepEqual(archive.calendar.days, expected.days);
  assert.equal(archive.sourceThrough.seconds, cutoff.seconds);
  const publication = job.collection('readingStatsRollupWeeksV1').doc('2026-11-16');
  const before = (await publication.get()).get('payload');
  time += weekMs;
  await store.doc(`${root}/readingStatsRollupBudgetsV1/${pacific.format(time)}`).set({ sourceReads: 3_992 });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { budget: 1 });
  assert.equal((await publication.get()).get('payload'), before);
  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  assert.deepEqual((await readPublishedReadingBootstrap(store, uid)).calendar.days, expected.days);
});

test('a first publication prepared after cutoff excludes already late day members', async (t) => {
  const lateApp = initializeApp({ projectId: 'demo-web-reader-day-late-first' }, 'day-late-first');
  t.after(() => deleteApp(lateApp));
  const store = getFirestore(lateApp);
  const uid = 'late-first';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const first = await identifyReadingDaySession(session(randomUUID(), '2026-11-22T14:00:00Z'));
  const late = await identifyReadingDaySession(session(randomUUID(), '2026-11-22T15:00:00Z'));
  const close = Date.parse('2026-11-24T09:00:00Z');
  const now = () => close + 86_400_000;
  await seedDayPart(store, uid, [
    { session: first, received: Timestamp.fromMillis(close - 1) },
    { session: late, received: Timestamp.fromMillis(close + 1) },
  ]);
  await job.create({ bootstrapDueAt: now(), bootstrap: {
    cutoff: Timestamp.fromMillis(now()), cursor: null, chunks: 0, bytes: 0, scanned: true,
  } });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { prepared: 1 });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  const archive = await readPublishedReadingBootstrap(store, uid);
  assert.deepEqual(archive.sourceThrough, { seconds: close / 1000, nanoseconds: 0 });
  assert.deepEqual(archive.calendar.days, computeWeeklyReadingRollup([first], '2026-11-16').days);
});

test('a large mixed-source week resumes its spilled checkpoint after two budget pauses', async (t) => {
  const spillApp = initializeApp({ projectId: 'demo-web-reader-day-rollup-spill' }, 'day-rollup-spill');
  t.after(() => deleteApp(spillApp));
  const store = getFirestore(spillApp);
  const uid = 'rollup-spill';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const scratch = job.collection('readingStatsRollupDayChunksV2');
  const sourceCutoff = Timestamp.fromMillis(Date.parse('2026-11-23T08:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const lease = await claimReadingRollup(store, uid, now);
  await stageReadingRollupHandoff(store, lease, {
    weeks: weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup([], week)),
    nextWeek, sourceCutoff, carry: createReadingRollupCarry([], nextWeek), pilotTuesday: true,
  }, now);
  await releaseReadingRollup(store, lease);

  const received = Timestamp.fromMillis(sourceCutoff.toMillis() + 60_000);
  const groups = await Promise.all(Array.from({ length: 3 }, (_, device) => Promise.all(
    Array.from({ length: 60 }, (_, i) => identifyReadingDaySession(session(randomUUID(),
      new Date(Date.parse('2026-11-22T05:00:00Z') + (device * 60 + i) * 180_000).toISOString(),
      { deviceId: `device-${device}`, bookTitle: '가'.repeat(700) }))),
  )));
  await Promise.all(groups.map((rows) => seedDayPart(store, uid, rows.map((value) => ({ session: value, received })))));
  const legacy = session('legacy-at-end', '2026-11-22T16:00:00Z');
  await store.doc(`${root}/users/${uid}/libraries/local/readingStatsV1/${legacy.sessionId}`).set({
    ...legacy, uploadedAtServer: Timestamp.fromMillis(received.toMillis() + 1),
  });

  time = Date.parse('2026-11-24T09:10:00Z');
  const budget = (date) => store.doc(`${root}/readingStatsRollupBudgetsV1/${date}`);
  await budget('2026-11-24').set({ sourceReads: 3_992 });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { budget: 1 });
  const first = JSON.parse((await job.get()).get('payload')).dayScan;
  assert.equal(first.scanned, true);
  assert.ok(first.spillCount > 1);
  assert.equal((await scratch.get()).size, first.spillCount);
  assert.equal(first.appliedDay, undefined);

  time += 86_400_000;
  await budget('2026-11-25').set({ sourceReads: 3_999 });
  assert.deepEqual(await runReadingRollupCron(store, { now }), { budget: 1 });
  assert.ok(JSON.parse((await job.get()).get('payload')).dayScan.appliedDay);
  assert.equal((await scratch.get()).size, first.spillCount);

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
  const payload = (await job.collection('readingStatsRollupWeeksV1').doc(nextWeek).get()).get('payload');
  assert.deepEqual(JSON.parse(payload), computeWeeklyReadingRollup([...groups.flat(), legacy], nextWeek));
  assert.equal((await scratch.get()).empty, true);
});

test('publication commits before cleaning more than 10 MiB of spilled inputs and cleanup resumes independently', async (t) => {
  const cleanupApp = initializeApp({ projectId: 'demo-web-reader-large-day-cleanup' }, 'large-day-cleanup');
  t.after(() => deleteApp(cleanupApp));
  const store = getFirestore(cleanupApp);
  const uid = 'day-cleanup';
  const job = store.doc(`${root}/readingStatsRollupJobsV1/${uid}`);
  const scratch = job.collection('readingStatsRollupDayChunksV2');
  const queue = store.collection(`${root}/readingStatsRollupDayCleanupV2`);
  const due = Date.parse('2026-11-24T09:00:00Z');
  let time = due;
  const now = () => time;
  const asStamp = (at) => [at / 1000, 0];
  const firstReceivedAt = { seconds: due / 1000 - 1, nanoseconds: 0 };
  const count = 30;
  let spillBytes = 0;
  // Model a resumed job that already consumed its input and is ready to publish.
  // Keep the carry small so the transaction only exercises temporary cleanup.
  const seed = store.batch();
  for (let index = 0; index < count; index++) {
    const payload = JSON.stringify(Array.from({ length: 110 }, (_, row) => ({
      session: session(`consumed-${index}-${row}`, '2026-11-15T00:00:00Z', { bookTitle: '가'.repeat(1_000) }),
      firstReceivedAt,
    })));
    const bytes = Buffer.byteLength(payload);
    assert.ok(bytes < 384 * 1024);
    spillBytes += bytes;
    seed.create(scratch.doc(`${nextWeek}_${String(index).padStart(4, '0')}`), { payload });
  }
  assert.ok(spillBytes > 10 * 1024 * 1024);
  await Promise.all([seed.commit(), job.create({ dueAt: due, payload: JSON.stringify({
    firstWeek: nextWeek, nextWeek, sourceAfter: asStamp(due - weekMs), closeAt: asStamp(due),
    cursor: null, scanned: true, tailPolicy: 2, carry: createReadingRollupCarry([], nextWeek), lastCalendarWeek: null, group: [],
    dayScan: {
      scanned: true, cursor: null, pending: [], spillCount: count, spillBytes,
      appliedDay: { firstReceivedAt, id: 'z' },
    },
  }) })]);

  let interruption = 'before-delete';
  const runTransaction = store.runTransaction.bind(store);
  t.mock.method(store, 'runTransaction', async (callback, options) => {
    let cleaning = false;
    const outcome = await runTransaction((tx) => {
      const get = tx.get.bind(tx);
      tx.get = (ref) => {
        if (ref.parent?.path === queue.path) {
          cleaning = true;
          if (interruption === 'before-delete') throw new Error('simulated cleanup failure');
        }
        return get(ref);
      };
      return callback(tx);
    }, options);
    if (cleaning && interruption === 'after-batch') time += 40_000;
    return outcome;
  });
  let metrics;
  const run = () => runReadingRollupCron(store, { now, reportQueue: (value) => { metrics = value; } });
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  assert.deepEqual(await run(), { published: 1 });
  assert.equal((await manifest.get()).get('publishedThroughWeek'), nextWeek);
  assert.equal((await scratch.select().get()).size, count);
  assert.equal((await queue.get()).docs[0].get('remaining'), count);
  assert.equal(metrics.dayCleanupFailures, 1);

  interruption = 'after-batch';
  time += weekMs;
  assert.deepEqual(await run(), { published: 1 }, 'the next week publishes with previous cleanup still pending');
  assert.equal((await manifest.get()).get('publishedThroughWeek'), '2026-11-23');
  assert.equal((await scratch.select().get()).size, count - 8);
  assert.equal((await queue.get()).docs[0].get('remaining'), count - 8);
  assert.equal(metrics.dayCleanupDocuments, 8);

  interruption = undefined;
  assert.deepEqual(await run(), {});
  assert.equal(metrics.dayCleanupDocuments, count - 8);
  assert.equal((await queue.get()).empty, true);
  assert.equal((await scratch.select().get()).empty, true);
  assert.deepEqual(await run(), {});
  assert.equal(metrics.dayCleanupDocuments, 0);
  assert.equal((await manifest.get()).get('publishedThroughWeek'), '2026-11-23');
});

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
    reading.doc('0-malformed-import').create({ schemaVersion: 1, sessionId: '0-malformed-import' }),
    reading.doc(legacy.sessionId).create(legacy),
    reading.doc(recent.sessionId).create({ ...recent, uploadedAtServer: Timestamp.fromMillis(cutoff - 1) }),
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
  await budget.set({ sourceReads: 3_998 });
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
  assert.equal((await reading.doc('0-malformed-import').get()).exists, true);

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
    .flatMap((doc) => JSON.parse(doc.get('payload')).map(({ session, sessionId }) => session?.sessionId ?? sessionId)).sort();
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

test('isolates damaged checkpoints and drains more than one page of healthy jobs', async (t) => {
  const app = initializeApp({ projectId: 'demo-web-reader-rollup-queue' }, 'rollup-queue-test');
  t.after(() => deleteApp(app));
  const store = getFirestore(app);
  const jobs = store.collection(`${root}/readingStatsRollupJobsV1`);
  const closeWeek = '2026-07-13';
  const cutoff = Date.parse('2026-07-21T09:00:00Z');
  let time = cutoff;
  const now = () => time;
  const stamp = (date) => [date / 1000, 0];
  const valid = {
    firstWeek: closeWeek, nextWeek: closeWeek, sourceAfter: stamp(cutoff - weekMs), closeAt: stamp(cutoff),
    cursor: null, scanned: false, carry: createReadingRollupCarry([], closeWeek), lastCalendarWeek: null, group: [],
  };
  const damaged = [
    { payload: '{' },
    { payload: JSON.stringify({ ...valid, carry: undefined }) },
    { payload: JSON.stringify({ ...valid, carry: { encoding: 'gzip-v1', data: 'AAAA' } }) },
    { payload: JSON.stringify({ ...valid, nextWeek: '2026-07-14' }) },
    { payload: JSON.stringify({ ...valid, carry: { sampleFloor: 0, sessions: [null] } }) },
    { payload: JSON.stringify({ ...valid, firstWeek: '2026-07-06', group: [
      { weekStart: '2026-07-06', days: [{ localDate: '2026-07-12', totalMs: 1, screenMs: 0, ttsMs: 0 }] },
    ] }) },
    {},
  ];
  const healthy = Array.from({ length: 8 }, (_, index) => jobs.doc(`healthy-${index}`));
  const transient = jobs.doc('transient');
  const healthyJob = { payload: JSON.stringify(valid), dueAt: cutoff - 1 };
  await Promise.all([
    ...damaged.map((data, index) => jobs.doc(`broken-${index}`).set({ ...data, dueAt: cutoff - 30 })),
    ...healthy.map(ref => ref.set(healthyJob)),
    transient.set({ ...healthyJob, dueAt: cutoff - 15 }),
    jobs.doc('broken-bootstrap').set({ bootstrapDueAt: cutoff, bootstrap: { chunks: -1 } }),
  ]);

  const prototype = Object.getPrototypeOf(transient);
  const originalGet = prototype.get;
  let failOnce = true;
  t.mock.method(prototype, 'get', function (...args) {
    if (this.path === transient.path && failOnce) {
      failOnce = false;
      throw new Error('transient read failure');
    }
    return originalGet.apply(this, args);
  });

  let queue;
  assert.deepEqual(await runReadingRollupCron(store, { now, reportQueue: value => { queue = value; } }),
    { blocked: 8, published: 8, failed: 1 });
  assert.equal(queue.regularVisited, 16);
  assert.equal(queue.bootstrapVisited, 1);
  assert.equal((await transient.get()).get('dueAt'), time + 3_600_000);
  const blocked = await jobs.doc('broken-0').get();
  assert.equal(blocked.get('blocked'), 'invalid-rollup-checkpoint');
  assert.equal(blocked.get('dueAt'), undefined);
  assert.equal(blocked.get('payload'), '{', 'retains the checkpoint for repair');
  for (const ref of healthy) {
    assert.equal((await ref.collection('readingStatsRollupManifestsV1').doc('current').get()).get('publishedThroughWeek'), closeWeek);
  }
  time += 3_600_000;
  assert.deepEqual(await runReadingRollupCron(store, { now }), { published: 1 });
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
  const later = session('b', '2026-11-17T01:00:00Z');
  const late = session('previous-week-late', '2026-11-15T10:00:00Z');
  const beforeFirstWeek = session('before-first-week', '2026-09-13T09:00:00Z');
  const stamp = Timestamp.fromDate(new Date('2026-11-23T16:00:00Z'));
  await Promise.all([
    // This row would stop the close if the scheduled path scanned old history.
    sourceRef(uid, 'old-session').set({ uploadedAtServer: Timestamp.fromMillis(first) }),
    sourceRef(uid, across.sessionId).set({ ...across, uploadedAtServer: Timestamp.fromMillis(time - 60_000) }),
    sourceRef(uid, 'a').set({ ...early, uploadedAtServer: Timestamp.fromMillis(Date.parse('2026-11-24T09:00:00Z')) }),
    sourceRef(uid, 'b').set({ ...later, uploadedAtServer: stamp }),
    sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: stamp }),
    sourceRef(uid, beforeFirstWeek.sessionId).set({ ...beforeFirstWeek, uploadedAtServer: stamp }),
    sourceRef(uid, 'next-cutoff').set({ uploadedAtServer: new Timestamp(Date.parse('2026-11-24T09:00:00Z') / 1000, 1_000) }),
  ]);
  time = Date.parse('2026-11-24T08:59:59Z');
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});
  time = Date.parse('2026-11-24T09:10:00Z');
  // Eight day-source reservations plus one legacy source slot.
  await quotaRef('2026-11-24').set({ sourceReads: 3_991 });
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
  assert.equal(result.coversHistoryStart, true, 'discarding a late row keeps the existing history coverage');
  assert.equal(result.sourceThrough.toMillis(), Date.parse('2026-11-24T09:00:00Z'));
  const expected = computeWeeklyReadingRollup([early, across, later, firstRead], nextWeek);
  assert.equal(expected.days.reduce((sum, day) => sum + day.totalMs, 0), 480_000);
  assert.deepEqual(JSON.parse((await weeks.doc(nextWeek).get()).get('payload')), expected);
  assert.deepEqual(JSON.parse((await calendar.get()).get('payload')), computeReadingCalendarRollup([...oldWeeks, expected]));
  assert.deepEqual(await readPublishedReadingFiles(db, uid), {
    firstDay: weekStarts[0], lastDay: '2026-11-22',
    files: mergeReadingFileRollups(...oldWeeks.map(({ files }) => files), expected.files),
  });
  assert.ok(JSON.parse((await filesRef.get()).get('payload')).carry);
  const { books } = await readPublishedReadingReportBooks(db, uid);
  const totalMs = [...oldWeeks, expected].flatMap(({ days }) => days).reduce((sum, day) => sum + day.totalMs, 0);
  assert.equal(books.length, 1);
  assert.deepEqual({ bookId: books[0].bookId, screenMs: books[0].screenMs, ttsMs: books[0].ttsMs },
    { bookId: 'book', screenMs: totalMs, ttsMs: 0 });
  assert.equal(JSON.parse((await job.get()).get('payload')).evidenceCompatible, true);
  assert.deepEqual(JSON.parse((await weeks.doc(weekStarts[8]).get()).get('payload')), oldWeeks[8]);
  assert.deepEqual(await runReadingRollupCron(db, { now }), {});

  time = Date.parse('2026-12-01T09:10:00Z');
  const afterInvalid = session('valid-after-invalid', '2026-11-26T00:03:00Z');
  await sourceRef(uid, afterInvalid.sessionId).set({ ...afterInvalid, uploadedAtServer: Timestamp.fromMillis(time - 3_600_000) });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  assert.equal((await job.get()).get('blocked'), undefined);
  assert.equal((await manifest.get()).get('publishedThroughWeek'), '2026-11-23');
  assert.ok(JSON.parse((await weeks.doc('2026-11-23').get()).get('payload')).days
    .some(({ localDate, totalMs }) => localDate === afterInvalid.localDate && totalMs === afterInvalid.durationMs));
  assert.equal((await sourceRef(uid, 'next-cutoff').get()).exists, true);
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
    const dayOffset = i < 980 ? 1 + Math.floor(i / 170) : 7;
    const minute = i < 980 ? i % 170 : i - 980;
    const startedAtClient = Date.parse(openWeek) + dayOffset * 86_400_000 + 9 * 3_600_000 + minute * 60_000;
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
  await quotaRef('2026-06-16').set({ sourceReads: 3_292 });
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

test('an old checkpoint replays a discarded page and publishes valid later rows after a budget pause', async () => {
  const uid = 'weekly-late-clock-resume';
  const sourceCutoff = Timestamp.fromDate(new Date('2026-11-23T08:00:00Z'));
  let time = sourceCutoff.toMillis();
  const now = () => time;
  const frozen = session('z-frozen', '2026-11-15T12:00:00Z', { deviceId: 'other-device' });
  const late = session('late-sunday', '2026-11-15T14:00:00Z', { timezoneOffsetMinutes: -540 });
  const tuesday = session('tuesday-clock', '2026-11-17T01:00:00Z', {
    timezoneOffsetMinutes: -540, clockOffsetMs: 500, clockUncertaintyMs: 0,
    clockMeasuredAtClient: Date.parse('2026-11-17T01:00:00Z'),
  });
  const weeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup([frozen], week));
  const lease = await claimReadingRollup(db, uid, now);
  await stageReadingRollupHandoff(db, lease, {
    weeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry([frozen], nextWeek), pilotTuesday: true,
  }, now);
  await releaseReadingRollup(db, lease);
  await Promise.all([
    sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: Timestamp.fromMillis(time + 60_000) }),
    sourceRef(uid, tuesday.sessionId).set({ ...tuesday, uploadedAtServer: Timestamp.fromMillis(time + 120_000) }),
  ]);

  const job = jobRef(uid);
  const details = job.collection('readingStatsRollupWeeksV1');
  const manifest = job.collection('readingStatsRollupManifestsV1').doc('current');
  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 3_991 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { budget: 1 });
  const checkpoint = JSON.parse((await job.get()).get('payload'));
  assert.equal(checkpoint.cursor.id, late.sessionId);
  assert.equal(checkpoint.carry.sessions.some(({ sessionId }) => sessionId === late.sessionId), false);
  assert.equal((await manifest.get()).exists, false);
  // Emulate a pre-upgrade writer that had already accepted that late input.
  checkpoint.tailPolicy = 1;
  checkpoint.carry.sessions.push(late);
  await job.update({ payload: JSON.stringify(checkpoint) });

  time += 86_400_000;
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: 1 });
  assert.equal((await manifest.get()).get('publishedThroughWeek'), nextWeek);
  assert.deepEqual(JSON.parse((await details.doc(nextWeek).get()).get('payload')),
    computeWeeklyReadingRollup([frozen, tuesday], nextWeek));
  assert.deepEqual(JSON.parse((await details.doc(weekStarts[8]).get()).get('payload')), weeks[8]);
});

test('late clock readings and overlapping TTS cannot change frozen weeks or block publication', async () => {
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
    {
      uid: 'changed-clock-within-closed-day',
      old: session('sunday-within-day', '2026-11-15T23:50:00Z'),
      late: session('late-clock-sample', '2026-11-17T01:00:00Z', {
        clockOffsetMs: 120_000, clockUncertaintyMs: 0, clockMeasuredAtClient: midnight - 5 * 60_000,
      }),
    },
  ];
  for (const { uid, old, late } of cases) {
    const weeks = weekStarts.slice(0, -1).map((week) => computeWeeklyReadingRollup([old], week));
    assert.equal(weeks.at(-1).days[0].totalMs, 180_000);
    assert.ok(computeWeeklyReadingRollup([old, late], nextWeek).days[0].totalMs > 0);
    assert.notDeepEqual(computeWeeklyReadingRollup([old, late], weekStarts[8]).activities, weeks.at(-1).activities);
    const lease = await claimReadingRollup(db, uid, now);
    await stageReadingRollupHandoff(db, lease, {
      weeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry([old], nextWeek), pilotTuesday: true,
    }, now);
    await releaseReadingRollup(db, lease);
    await sourceRef(uid, late.sessionId).set({ ...late, uploadedAtServer: Timestamp.fromMillis(time + 60_000) });
  }

  time = Date.parse('2026-11-24T09:10:00Z');
  await quotaRef('2026-11-24').set({ sourceReads: 0 });
  assert.deepEqual(await runReadingRollupCron(db, { now }), { published: cases.length });
  for (const { uid } of cases) {
    const job = jobRef(uid);
    assert.equal((await job.get()).get('blocked'), undefined);
    const weeks = job.collection('readingStatsRollupWeeksV1');
    assert.equal(JSON.parse((await weeks.doc(weekStarts[8]).get()).get('payload')).days[0].totalMs, 180_000);
    assert.deepEqual(JSON.parse((await weeks.doc(nextWeek).get()).get('payload')).days, []);
    assert.equal((await job.collection('readingStatsRollupManifestsV1').doc('current').get()).get('publishedThroughWeek'), nextWeek);
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
