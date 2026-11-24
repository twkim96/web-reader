import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeLocalDB, initDB } from '../src/lib/localDB.ts';
import {
  LOCAL_DB_NAME,
  LOCAL_DB_VERSION,
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
  readingStatisticsArchiveKey,
  readingStatisticsRecentKey,
} from '../src/lib/localDBSchema.ts';
import {
  adoptLegacyReadingStatisticsCursorV12,
  beginReadingStatisticsRecentRecovery,
  deferReadingSessionSyncV11,
  confirmLocalReadingRoundV11,
  getReadingStatisticsHydrationPlanV12,
  getReadingStatisticsHydrationStateV12,
  getLocalReadingReportSnapshot,
  getLocalReadingRollupArchive,
  getLocalReadingSessionsV11,
  getPendingReadingSessionsV11,
  hydrateRemoteReadingSessionsPageV12,
  installReadingStatisticsBootstrap,
  markReadingSessionSyncedV11,
  PublishedReadingTailError,
  reconcileUploadedReadingSessionConflictV11,
  recordReadingStatisticsHydrationMetricsV12,
  recordReadingStatisticsVerifiedAuditV12,
  saveLocalReadingSessionV11,
} from '../src/lib/localReadingStatistics.ts';
import {
  acquireReadingStatisticsSyncLeaseV13,
} from '../src/lib/readingStatisticsSyncLease.ts';
import { catchUpReadingStatisticsAuditAsLeader } from '../src/lib/readingStatisticsSyncCoordinator.ts';
import { parseReadingRollupBootstrap } from '../src/lib/readingRollupBootstrap.ts';
import {
  getReadingStatisticsDraftKey,
  getReadingStatisticsDraftRecoveryEnd,
} from '../src/lib/readingStatisticsDraft.ts';
import {
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
} from '../src/lib/ownerIdentity.ts';
import {
  buildReadingBookRounds,
  buildReadingStatistics,
  createReadingRoundCompletionSession,
  getReadingSessionLocalDate,
} from '../src/lib/readingStatistics.ts';

const owner = makeOwnerKey(makeFirebaseOwnerKey('stats-alice'), 'library:local');
const guest = makeOwnerKey(makeGuestOwnerKey('stats-guest'), 'library:local');
const cursor = (seconds, documentId, nanoseconds = 0) => ({
  uploadedAtServerSeconds: seconds,
  uploadedAtServerNanoseconds: nanoseconds,
  documentId,
});

const makeSession = (sessionId = 'session-1', bookTitle = 'Book') => ({
  schemaVersion: 1,
  sessionId,
  bookId: 'book-1',
  bookTitle,
  deviceId: 'device-1',
  mode: 'screen',
  startedAtClient: 1_000,
  endedAtClient: 61_000,
  durationMs: 60_000,
  startProgressPercent: 10,
  endProgressPercent: 20,
  timezoneOffsetMinutes: 0,
  localDate: getReadingSessionLocalDate(1_000, 0),
  completed: false,
});

test('a statistics snapshot does not treat the first received page as the complete raw history', async () => {
  const reportOwner = makeOwnerKey(makeFirebaseOwnerKey('report-snapshot'), 'library:local');
  const first = makeSession('report-first');
  const firstCursor = cursor(60, first.sessionId);
  await hydrateRemoteReadingSessionsPageV12(reportOwner, [first], null, firstCursor, false, false);
  const partial = await getLocalReadingReportSnapshot(reportOwner, true);
  assert.deepEqual(partial.sessions.map(({ sessionId }) => sessionId), [first.sessionId]);
  assert.equal(partial.rawHistoryComplete, false);
  await hydrateRemoteReadingSessionsPageV12(reportOwner, [], firstCursor, null, true, false);
  assert.equal((await getLocalReadingReportSnapshot(reportOwner, true)).rawHistoryComplete, true);
  const db = await initDB();
  await db.delete(V11_READING_SESSIONS_STORE, [reportOwner, first.sessionId]);
  assert.equal((await getLocalReadingReportSnapshot(reportOwner, true)).rawHistoryComplete, false);
});

const publishedRead = (id, at) => {
  const startedAtClient = Date.parse(at);
  return { ...makeSession(id), startedAtClient, endedAtClient: startedAtClient + 60_000,
    localDate: getReadingSessionLocalDate(startedAtClient, 0) };
};

const publishedFixture = () => parseReadingRollupBootstrap({
  calendar: { firstDay: '2026-09-14', lastDay: '2026-11-22', days: [] },
  files: [], books: [],
  sourceThrough: { seconds: Date.parse('2026-11-25T00:00:00Z') / 1000, nanoseconds: 219 },
  carry: {
    sampleFloor: Date.parse('2026-11-20'), sessions: [publishedRead('already-uploaded', '2026-11-24T12:00:00Z')],
  },
});

test('a new device keeps the carry before the cutoff and resumes its received tail after a restart', async () => {
  const bootstrap = publishedFixture();
  assert.ok(bootstrap);
  const now = Date.parse('2026-11-26T00:00:00Z');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'seeded', now);
  await saveLocalReadingSessionV11(owner, publishedRead('pending', '2026-11-25T15:00:00Z'));
  assert.equal(await installReadingStatisticsBootstrap(owner, bootstrap, lease, now), true);
  const initial = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.equal(initial.state.cursor, null);
  assert.deepEqual(initial.published.sourceThrough, bootstrap.sourceThrough);
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId, syncState }) => [sessionId, syncState]),
    [['already-uploaded', 'synced'], ['pending', 'pending']]);
  assert.equal((await getLocalReadingReportSnapshot(owner, true)).tailComplete, false);

  await hydrateRemoteReadingSessionsPageV12(owner, [], null, null, true, false, [], now, lease, true, initial.published);
  await closeLocalDB();
  const emptyTail = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.equal(emptyTail.state.cursor, null);
  assert.deepEqual(emptyTail.published.sourceThrough, bootstrap.sourceThrough);
  const visible = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(visible.tailComplete, true);
  assert.equal(visible.rawHistoryComplete, false);

  const remote = publishedRead('new-upload', '2026-11-25T20:00:00Z');
  const last = cursor(bootstrap.sourceThrough.seconds + 1, remote.sessionId, 119);
  await hydrateRemoteReadingSessionsPageV12(owner, [remote], null, last, false, false, [], now, lease, true, initial.published);
  await closeLocalDB();
  const resumed = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.deepEqual(resumed.state.cursor, last);
  assert.equal(resumed.state.fullHydrationCompleted, false);
  await hydrateRemoteReadingSessionsPageV12(owner, [], last, last, true, false, [], now, lease, true, initial.published);
  assert.equal((await getLocalReadingReportSnapshot(owner, true)).tailComplete, true);
  assert.deepEqual((await getReadingStatisticsHydrationPlanV12(owner, now, false)), { reason: 'published-history-unavailable' });
});

test('old recent-only recovery can adopt the same publication and skip a late boundary upload', async () => {
  const bootstrap = publishedFixture();
  const now = Date.parse('2026-11-26T00:00:00Z');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'upgrade', now);
  const late = publishedRead('late-first-open-day', '2026-11-23T13:00:00Z');
  const normal = publishedRead('normal-open-day', '2026-11-25T11:00:00Z');
  const last = cursor(bootstrap.sourceThrough.seconds + 2, late.sessionId, 92);
  await installReadingStatisticsBootstrap(owner, bootstrap, lease, now);
  await beginReadingStatisticsRecentRecovery(owner, lease, now, bootstrap.sourceThrough);
  await hydrateRemoteReadingSessionsPageV12(owner, [late, normal], null, last, true, false, [], now, lease, true, undefined, true);
  const db = await initDB();
  const recoveryKey = readingStatisticsRecentKey(owner);
  const previous = await db.get(V12_READING_STATISTICS_SYNC_STORE, recoveryKey);
  delete previous.rejectionVersion;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, previous);
  await closeLocalDB();

  assert.equal(await installReadingStatisticsBootstrap(owner, bootstrap, lease, now), true);
  const { published } = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  await hydrateRemoteReadingSessionsPageV12(owner, [normal, late], null, last, true, false, [], now, lease, true, published);
  await closeLocalDB();
  const plan = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.deepEqual(plan.state.cursor, last);
  assert.deepEqual((await getLocalReadingRollupArchive(owner)).calendar, bootstrap.calendar);
  const report = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(report.tailComplete, true);
  assert.deepEqual(report.sessions.map(({ sessionId }) => sessionId), ['already-uploaded', normal.sessionId]);
  await saveLocalReadingSessionV11(owner, late);
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId }) => sessionId), ['already-uploaded', normal.sessionId]);
});

test('a malformed published upload still uses bounded recovery and rejects its checkpoint after a restart', async () => {
  const bootstrap = publishedFixture();
  const now = Date.parse('2026-11-26T00:00:00Z');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'recover', now);
  await installReadingStatisticsBootstrap(owner, bootstrap, lease, now);
  const { published } = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  const old = publishedRead('late-closed-date', '2026-11-22T23:59:00Z');
  const last = cursor(bootstrap.sourceThrough.seconds + 1, old.sessionId, 92);
  await assert.rejects(
    hydrateRemoteReadingSessionsPageV12(owner, [], null, last, true, false, [{
      documentId: last.documentId, reason: 'invalid-schema', detectedAt: now,
    }], now, lease, true, published),
    PublishedReadingTailError,
  );
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId }) => sessionId), ['already-uploaded']);
  const pending = publishedRead('other-device-pending', '2026-11-25T10:00:00Z');
  await saveLocalReadingSessionV11(owner, pending);
  await beginReadingStatisticsRecentRecovery(owner, lease, now, published.sourceThrough);
  assert.equal(await getLocalReadingRollupArchive(owner), 'unavailable');
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, now, true)).state.cursor, null);
  await hydrateRemoteReadingSessionsPageV12(owner, [old], null, last, false, false, [], now, lease, true, undefined, true);
  const db = await initDB();
  const legacyMeta = await db.get(V12_READING_STATISTICS_SYNC_STORE, owner);
  delete legacyMeta.published;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, legacyMeta);
  await closeLocalDB();
  await beginReadingStatisticsRecentRecovery(owner, lease, now);
  const plan = await getReadingStatisticsHydrationPlanV12(owner, now, false);
  assert.equal(plan.recentOnly, true);
  assert.deepEqual(plan.state.cursor, last);
  assert.equal(plan.published, undefined);
  await hydrateRemoteReadingSessionsPageV12(owner, [], last, last, true, false, [], now, lease, true, undefined, true);
  assert.equal(await getLocalReadingRollupArchive(owner), 'unavailable');
  const snapshot = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(snapshot.recentOnly, true);
  assert.equal(snapshot.rawHistoryComplete, false);
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, now, true)).state.lastFullAuditAt, 0);
  assert.deepEqual(snapshot.sessions.map(({ sessionId, syncState }) => [sessionId, syncState]), [
    ['late-closed-date', 'synced'], ['already-uploaded', 'synced'], ['other-device-pending', 'pending'],
  ]);
  assert.equal(await installReadingStatisticsBootstrap(owner, bootstrap, lease, now), false);
  const waiting = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.equal(waiting.recentOnly, true);
  assert.deepEqual(waiting.state.cursor, last);
  const repaired = { ...bootstrap, sourceThrough: { seconds: last.uploadedAtServerSeconds + 1, nanoseconds: 0 } };
  assert.equal(await installReadingStatisticsBootstrap(owner, repaired, lease, now), true);
  const restored = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.equal(restored.recentOnly, undefined);
  assert.deepEqual(restored.published.sourceThrough, repaired.sourceThrough);
  assert.equal((await getLocalReadingRollupArchive(owner)).calendar.lastDay, repaired.calendar.lastDay);
});

test('an existing device compacts closed sessions and resumes past a late archived upload without a raw row', async () => {
  const bootstrap = publishedFixture();
  const now = Date.parse('2026-11-26T00:00:00Z');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'archive-local-history', now);
  const old = publishedRead('old-synced', '2026-11-09T12:00:00Z');
  const pending = publishedRead('old-pending', '2026-11-10T12:00:00Z');
  const boundary = publishedRead('near-boundary', '2026-11-22T23:59:00Z');
  const clock = {
    ...publishedRead('open-clock-sample', '2026-11-20T12:00:00Z'), clockMeasuredAtClient: Date.parse('2026-11-20T12:00:00Z'),
    clockOffsetMs: 0, clockUncertaintyMs: 0,
  };
  bootstrap.carry.sessions.push(clock, boundary);
  const initial = cursor(bootstrap.sourceThrough.seconds - 180, clock.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [old, boundary, clock], null, initial, true, false, [], now, lease);
  await saveLocalReadingSessionV11(owner, pending);
  assert.equal((await getLocalReadingReportSnapshot(owner, true)).rawHistoryComplete, true);
  assert.equal(await installReadingStatisticsBootstrap(owner, bootstrap, lease, now, undefined, true), true);
  const { published } = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId }) => sessionId),
    [clock.sessionId, boundary.sessionId, 'already-uploaded']);

  const late = publishedRead('late-archived', '2026-11-15T04:00:00Z');
  const last = cursor(bootstrap.sourceThrough.seconds + 1, late.sessionId, 86);
  await hydrateRemoteReadingSessionsPageV12(owner, [late], null, last, false, false, [], now, lease, true, published);
  await hydrateRemoteReadingSessionsPageV12(owner, [], last, last, true, false, [], now, lease, true, published);
  await closeLocalDB();
  const plan = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.deepEqual(plan.state.cursor, last);
  const snapshot = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(snapshot.tailComplete, true);
  assert.equal(snapshot.rawHistoryComplete, false);
  assert.equal(snapshot.sessions.some(({ sessionId }) => sessionId === late.sessionId), false);
  assert.deepEqual((await getLocalReadingRollupArchive(owner)).calendar, bootstrap.calendar);

  const open = publishedRead('open-after-late', '2026-11-25T12:00:00Z');
  const openCursor = cursor(last.uploadedAtServerSeconds + 1, open.sessionId, 12);
  await hydrateRemoteReadingSessionsPageV12(owner, [open], last, openCursor, true, false, [], now, lease, true, published);
  const db = await initDB();
  assert.equal((await db.get(V12_READING_STATISTICS_SYNC_STORE, owner)).archivedCursor, undefined);

  const legacyMeta = await db.get(V12_READING_STATISTICS_SYNC_STORE, owner);
  delete legacyMeta.published;
  legacyMeta.lastFullAuditAt = now - 1;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, legacyMeta);
  const fallback = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(fallback.rawHistoryComplete, false);
  assert.equal(fallback.recentOnly, true);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, now, true), { reason: 'published-history-unavailable' });
  await beginReadingStatisticsRecentRecovery(owner, lease, now);
  const narrower = { ...bootstrap, calendar: { ...bootstrap.calendar, firstDay: '2026-09-21' } };
  assert.equal(await installReadingStatisticsBootstrap(owner, narrower, lease, now), false);
  assert.equal(await installReadingStatisticsBootstrap(owner, bootstrap, lease, now), true);
});

test('recent recovery policy keeps a verified complete local history on the incremental audit path', async () => {
  const fullAt = Date.parse('2026-10-20T10:00:00Z');
  const now = Date.parse('2026-11-23T10:00:00Z');
  const first = publishedRead('first-read', '2026-10-20T09:00:00Z');
  const recent = publishedRead('recent-read', '2026-11-22T12:00:00Z');
  const firstCursor = cursor(fullAt / 1000, first.sessionId);
  const recentCursor = cursor(Date.parse('2026-11-22T13:00:00Z') / 1000, recent.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [first], null, firstCursor, true, false, [], fullAt);
  await hydrateRemoteReadingSessionsPageV12(owner, [recent], firstCursor, recentCursor, true, false, [], now, undefined, true);
  const { candidate } = await getReadingStatisticsHydrationPlanV12(owner, now, false, true);
  assert.deepEqual(candidate.cursor, recentCursor);
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'bounded-audit', now);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => now, true), true);
  const report = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(report.rawHistoryComplete, true);
  assert.equal(report.recentOnly, false);
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, now, false, true)).state.lastFullAuditAt, fullAt);
});

test('a device upload counts in the tail only once the remote cursor receives it', async () => {
  const bootstrap = publishedFixture();
  const now = Date.parse('2026-11-26');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'received-tail', now);
  await installReadingStatisticsBootstrap(owner, bootstrap, lease, now);
  const { published } = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  const uploaded = publishedRead('locally-uploaded', '2026-11-25T01:00:00Z');
  const lastUpload = publishedRead('later-upload', '2026-11-25T02:00:00Z');
  await saveLocalReadingSessionV11(owner, uploaded);
  await markReadingSessionSyncedV11(owner, uploaded.sessionId, uploaded);
  const last = cursor(bootstrap.sourceThrough.seconds + 100, lastUpload.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [uploaded, lastUpload], null, last, true, false, [], now, lease, true, published);
  assert.equal((await getLocalReadingReportSnapshot(owner, true)).tailComplete, true);
  const unrelated = publishedRead('uploaded-but-unreceived', '2026-11-25T03:00:00Z');
  await saveLocalReadingSessionV11(owner, unrelated);
  await markReadingSessionSyncedV11(owner, unrelated.sessionId, unrelated);
  const db = await initDB();
  await db.delete(V11_READING_SESSIONS_STORE, [owner, uploaded.sessionId]);
  assert.equal((await getLocalReadingReportSnapshot(owner, true)).tailComplete, false);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, now, true), { reason: 'published-history-unavailable' });
});

test('a newer publication restarts its tail at the new floor before trusting previously seen uploads', async () => {
  const bootstrap = publishedFixture();
  const now = Date.parse('2026-12-04');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'new-publication', now);
  await installReadingStatisticsBootstrap(owner, bootstrap, lease, now);
  const { published } = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  const opened = publishedRead('previously-safe', '2026-11-26T12:00:00Z');
  const next = {
    ...bootstrap,
    calendar: { ...bootstrap.calendar, lastDay: '2026-11-29' },
    sourceThrough: { seconds: Date.parse('2026-12-02') / 1000, nanoseconds: 120 },
    carry: { sampleFloor: Date.parse('2026-11-27'), sessions: [] },
  };
  const afterNewFloor = cursor(next.sourceThrough.seconds + 1, opened.sessionId, 1);
  await hydrateRemoteReadingSessionsPageV12(owner, [opened], null, afterNewFloor, true, false, [], now, lease, true, published);
  assert.equal(await installReadingStatisticsBootstrap(owner, next, lease, now, published), true);
  const revalidated = await getReadingStatisticsHydrationPlanV12(owner, now, true);
  assert.equal(revalidated.state.cursor, null);
  assert.equal(revalidated.state.fullHydrationCompleted, false);
  assert.deepEqual(revalidated.published.sourceThrough, next.sourceThrough);
  await hydrateRemoteReadingSessionsPageV12(owner, [opened], null, afterNewFloor, true, false, [], now, lease, true, revalidated.published);
  const snapshot = await getLocalReadingReportSnapshot(owner, true);
  assert.equal(snapshot.tailComplete, true);
  assert.equal(snapshot.sessions.some(({ sessionId }) => sessionId === opened.sessionId), false);
});

test('a corrupt saved publication cannot authorize a timestamp skip', async () => {
  const now = Date.parse('2026-11-26');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'bad-archive', now);
  await installReadingStatisticsBootstrap(owner, publishedFixture(), lease, now);
  const db = await initDB();
  await db.put(V12_READING_STATISTICS_SYNC_STORE, { ownerKey: readingStatisticsArchiveKey(owner), archive: {} });
  assert.equal(await getLocalReadingRollupArchive(owner), 'unavailable');
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, now, true), { reason: 'published-history-unavailable' });
});

const deleteDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('statistics test database deletion blocked'));
  });
};

test.beforeEach(deleteDatabase);
test.after(deleteDatabase);

test('v12 creates owner sessions and an atomic hydration cursor store', async () => {
  const db = await initDB();
  assert.equal(db.version, LOCAL_DB_VERSION);
  assert.equal(db.objectStoreNames.contains(V11_READING_SESSIONS_STORE), true);
  assert.equal(db.objectStoreNames.contains(V12_READING_STATISTICS_SYNC_STORE), true);
  const store = db.transaction(V11_READING_SESSIONS_STORE).objectStore(V11_READING_SESSIONS_STORE);
  assert.equal(store.indexNames.contains('by-owner-sync-next-attempt'), true);
  assert.equal(store.indexNames.contains('by-owner-book'), true);
});

test('uses a distinct durable draft journal key for every closed session', () => {
  const first = getReadingStatisticsDraftKey(owner, 'device-1', 'book-1', 'session-1');
  const second = getReadingStatisticsDraftKey(owner, 'device-1', 'book-1', 'session-2');
  assert.notEqual(first, second);
  assert.match(first, /session-1$/);
});

test('simultaneous statistics readers share one owner query and later reads see committed writes', async (t) => {
  const record = { ...makeSession(), mode: 'tts', activeIntervals: [{ startedAtClient: 1_000, endedAtClient: 61_000 }] };
  await saveLocalReadingSessionV11(owner, record);
  await saveLocalReadingSessionV11(guest, makeSession('guest-only'));
  const reads = t.mock.method(IDBIndex.prototype, 'getAll');
  const [dashboard, readBooks, guestRows] = await Promise.all([
    getLocalReadingSessionsV11(owner), getLocalReadingSessionsV11(owner), getLocalReadingSessionsV11(guest),
  ]);
  const readsFor = (key) => reads.mock.calls.filter(({ arguments: [query] }) => query === key).length;
  assert.equal(readsFor(owner), 1);
  assert.equal(readsFor(guest), 1);
  assert.deepEqual(guestRows.map(({ sessionId }) => sessionId), ['guest-only']);
  assert.deepEqual(dashboard, readBooks);
  dashboard[0].activeIntervals[0].startedAtClient++;
  assert.equal(readBooks[0].activeIntervals[0].startedAtClient, 1_000);

  await saveLocalReadingSessionV11(owner, makeSession('next-session'));
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId }) => sessionId), ['next-session', 'session-1']);
  assert.equal(readsFor(owner), 2);
});

test('stores Firebase sessions pending, replays idempotently, and hydrates them synced', async () => {
  const record = makeSession();
  await saveLocalReadingSessionV11(owner, record);
  await saveLocalReadingSessionV11(owner, record);
  assert.equal((await getPendingReadingSessionsV11(owner, Date.now())).length, 1);
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [record],
    null,
    cursor(1, record.sessionId),
    true,
  );
  const stored = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].syncState, 'synced');
  await assert.rejects(
    saveLocalReadingSessionV11(owner, makeSession('session-1', 'Different')),
    /충돌/,
  );
});

test('atomically confirms only the latest reading round', async () => {
  await saveLocalReadingSessionV11(owner, {
    ...makeSession('eligible-round'),
    endProgressPercent: 99,
  });
  const result = await confirmLocalReadingRoundV11(owner, 'book-1', 1, 62_000);
  assert.equal(result.status, 'created');
  const stored = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.length, 2);
  const marker = stored.find(({ completionConfirmedAtClient }) => (
    completionConfirmedAtClient !== undefined
  ));
  assert.equal(marker?.completed, true);
  assert.equal(marker?.completionConfirmedAtClient, 62_000);
  assert.equal(marker?.completionRoundNumber, 1);
  assert.equal(marker?.syncState, 'pending');
  assert.equal((await confirmLocalReadingRoundV11(owner, 'book-1', 1, 63_000)).status, 'already-completed');
});

test('confirms a reading round below 99 percent when the user explicitly completes it', async () => {
  await saveLocalReadingSessionV11(owner, {
    ...makeSession('partial-round'),
    endProgressPercent: 98.9,
  });
  const result = await confirmLocalReadingRoundV11(owner, 'book-1', 1, 62_000);
  assert.equal(result.status, 'created');
  const stored = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.length, 2);
  assert.equal(stored.some(({ completionConfirmedAtClient }) => (
    completionConfirmedAtClient === 62_000
  )), true);
});

test('concurrent local confirmation and offline remote duplicate converge on one completed round', async () => {
  const source = makeSession('shared-round');
  await saveLocalReadingSessionV11(owner, source);
  const outcomes = await Promise.all([
    confirmLocalReadingRoundV11(owner, source.bookId, 1, 62_000),
    confirmLocalReadingRoundV11(owner, source.bookId, 1, 63_000),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ['already-completed', 'created']);
  const offline = createReadingRoundCompletionSession({
    sessions: [source], bookId: source.bookId, expectedRoundNumber: 1,
    sessionId: 'remote-offline-confirmation', confirmedAtClient: 64_000,
  });
  assert.equal(offline.status, 'created');
  await hydrateRemoteReadingSessionsPageV12(owner, [offline.session], null, cursor(1, offline.session.sessionId), true);
  const records = await getLocalReadingSessionsV11(owner);
  assert.equal(records.length, 3);
  assert.equal(records.find(({ sessionId }) => sessionId === offline.session.sessionId).completionRoundNumber, 1);
  const rounds = buildReadingBookRounds(records);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].completed, true);
  assert.equal(rounds[0].totalMs, 60_000);
  assert.equal(buildReadingStatistics(records).totalMs, 60_000);
});

test('round-trips TTS active wall-clock intervals without compressing gaps', async () => {
  const record = {
    ...makeSession('tts-intervals'),
    mode: 'tts',
    endedAtClient: 601_000,
    durationMs: 300_000,
    activeIntervals: [
      { startedAtClient: 1_000, endedAtClient: 151_000 },
      { startedAtClient: 451_000, endedAtClient: 601_000 },
    ],
  };
  await saveLocalReadingSessionV11(owner, record);
  const [stored] = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.startedAtClient, 1_000);
  assert.equal(stored.endedAtClient, 601_000);
  assert.equal(stored.durationMs, 300_000);
  assert.deepEqual(stored.activeIntervals, record.activeIntervals);
});

test('recovers a TTS draft through the last journaled active interval end', () => {
  assert.equal(getReadingStatisticsDraftRecoveryEnd({
    state: 'active',
    lastHeartbeatAt: 1_000,
    activeIntervals: [
      { endedAtClient: 5_000 },
    ],
  }), 5_000);
  assert.equal(getReadingStatisticsDraftRecoveryEnd({
    state: 'closed-pending',
    closedAtClient: 6_000,
    lastHeartbeatAt: 1_000,
    activeIntervals: [
      { endedAtClient: 5_000 },
    ],
  }), 6_000);
});

test('keeps guest sessions local and defers failed Firebase uploads', async () => {
  await saveLocalReadingSessionV11(guest, makeSession('guest-session'));
  assert.equal((await getLocalReadingSessionsV11(guest))[0].syncState, 'synced');

  await saveLocalReadingSessionV11(owner, makeSession('pending-session'));
  await deferReadingSessionSyncV11(owner, 'pending-session', 'unavailable', 10_000);
  assert.equal((await getPendingReadingSessionsV11(owner, 10_000)).length, 0);
  const deferred = await getPendingReadingSessionsV11(owner, 80_000);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].retryCount, 1);
  assert.equal(deferred[0].lastErrorCode, 'unavailable');
});

test('commits each authoritative hydration page and tuple cursor atomically', async () => {
  const first = makeSession('remote-1');
  const second = { ...makeSession('remote-2'), startedAtClient: 62_000, endedAtClient: 122_000 };
  const cursor1 = cursor(10, first.sessionId, 1);
  const cursor2 = cursor(10, second.sessionId, 2);
  await hydrateRemoteReadingSessionsPageV12(owner, [first], null, cursor1, false, true, [], 10_000);
  assert.deepEqual(await getReadingStatisticsHydrationStateV12(owner, 20_000), {
    cursor: cursor1,
    fullHydrationCompleted: false,
    quarantinedDocuments: [],
    lastFullAuditAt: 0,
  });
  await hydrateRemoteReadingSessionsPageV12(owner, [second], cursor1, cursor2, true, true, [], 20_000);
  assert.deepEqual(await getReadingStatisticsHydrationStateV12(owner, 20_000), {
    cursor: cursor2,
    fullHydrationCompleted: true,
    quarantinedDocuments: [],
    lastFullAuditAt: 20_000,
  });
  assert.equal((await getLocalReadingSessionsV11(owner)).length, 2);
});

test('a failed first query does not certify that the remote statistics history is empty', async () => {
  const now = 200_000;
  await recordReadingStatisticsHydrationMetricsV12(owner, {
    pageCount: 0, remoteReadCount: 0, durationMs: 100, completedAt: now, status: 'failed',
  });
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, now)).reason, 'initial-history');
  await hydrateRemoteReadingSessionsPageV12(owner, [], null, null, true, true, [], now);
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, now)).reason, 'empty-history');
});

test('discards a surviving cursor when the raw session store was cleared', async () => {
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner), { reason: 'initial-history' });
  const record = makeSession('remote-cleared');
  const remoteCursor = cursor(20, record.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [record], null, remoteCursor, true);
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  await tx.objectStore(V11_READING_SESSIONS_STORE).clear();
  await tx.done;
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner), { reason: 'local-history-missing' });
});

test('converges a colliding local session on the immutable remote payload and advances hydration', async () => {
  const local = makeSession('remote-collision', 'Local');
  const remote = { ...local, bookTitle: 'Remote' };
  const following = {
    ...makeSession('remote-following', 'Following'),
    startedAtClient: 62_000,
    endedAtClient: 122_000,
  };
  await saveLocalReadingSessionV11(owner, local);
  const nextCursor = cursor(20, following.sessionId);
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [remote, following],
    null,
    nextCursor,
    true,
  );
  const stored = await getLocalReadingSessionsV11(owner);
  assert.deepEqual(stored.map(({ sessionId, bookTitle, syncState }) => ({
    sessionId,
    bookTitle,
    syncState,
  })), [
    { sessionId: remote.sessionId, bookTitle: 'Remote', syncState: 'synced' },
    { sessionId: following.sessionId, bookTitle: 'Following', syncState: 'synced' },
  ]);
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner))?.cursor, nextCursor);
  assert.equal((await getPendingReadingSessionsV11(owner, Date.now())).length, 0);
});

test('reconciles an upload collision to the remote payload without blocking later pending sessions', async () => {
  const local = makeSession('upload-collision', 'Local');
  const remote = { ...local, bookTitle: 'Remote' };
  const following = {
    ...makeSession('upload-following', 'Following'),
    startedAtClient: 62_000,
    endedAtClient: 122_000,
  };
  await saveLocalReadingSessionV11(owner, local);
  await saveLocalReadingSessionV11(owner, following);
  assert.equal(await reconcileUploadedReadingSessionConflictV11(
    owner,
    local,
    remote,
  ), true);
  const stored = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.find(({ sessionId }) => sessionId === local.sessionId)?.bookTitle, 'Remote');
  assert.equal(stored.find(({ sessionId }) => sessionId === local.sessionId)?.syncState, 'synced');
  assert.deepEqual(
    (await getPendingReadingSessionsV11(owner, Date.now())).map(({ sessionId }) => sessionId),
    [following.sessionId],
  );
});

test('does not reconcile an upload collision after the statistics lease changes', async () => {
  const local = makeSession('upload-stale-lease', 'Local');
  const remote = { ...local, bookTitle: 'Remote' };
  await saveLocalReadingSessionV11(owner, local);
  const staleLease = await acquireReadingStatisticsSyncLeaseV13(owner, 'old-tab', 100, 50);
  await acquireReadingStatisticsSyncLeaseV13(owner, 'new-tab', 151, 50);
  assert.equal(await reconcileUploadedReadingSessionConflictV11(
    owner,
    local,
    remote,
    staleLease,
    152,
  ), false);
  const [stored] = await getLocalReadingSessionsV11(owner);
  assert.equal(stored.bookTitle, 'Local');
  assert.equal(stored.syncState, 'pending');
});

test('keeps malformed remote documents quarantined while advancing the exact cursor', async () => {
  const record = makeSession('remote-valid');
  const nextCursor = cursor(30, 'remote-invalid', 123);
  const quarantined = [{
    documentId: 'remote-invalid',
    reason: 'schema mismatch',
    detectedAt: 40_000,
  }];
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [record],
    null,
    nextCursor,
    true,
    true,
    quarantined,
    50_000,
  );
  const hydration = await getReadingStatisticsHydrationStateV12(owner, 50_000);
  assert.deepEqual(hydration?.cursor, nextCursor);
  assert.deepEqual(hydration?.quarantinedDocuments, quarantined);
  assert.equal(hydration?.lastFullAuditAt, 50_000);
  assert.equal((await getLocalReadingSessionsV11(owner)).length, 1);
});

test('records a completed quarantine-only hydration without a timestamp cursor', async () => {
  const quarantined = [{
    documentId: 'bad-upload-time',
    reason: '원격 독서 통계 upload cursor가 올바르지 않습니다.',
    detectedAt: 45_000,
  }];
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [],
    null,
    null,
    true,
    true,
    quarantined,
    55_000,
  );
  const hydration = await getReadingStatisticsHydrationStateV12(owner, 55_000);
  assert.equal(hydration?.cursor, null);
  assert.equal(hydration?.fullHydrationCompleted, true);
  assert.deepEqual(hydration?.quarantinedDocuments, quarantined);
  assert.equal(hydration?.lastFullAuditAt, 55_000);

  await closeLocalDB();
  const plan = await getReadingStatisticsHydrationPlanV12(owner, 56_000);
  assert.equal(plan.fullAuditInProgress, false);
  await hydrateRemoteReadingSessionsPageV12(
    owner, [], plan.state.cursor, null, true, false, [], 56_000, undefined, true,
  );
  const checked = await getReadingStatisticsHydrationStateV12(owner, 56_000);
  assert.deepEqual(checked, hydration, 'an empty timestamp-range poll preserves quarantine and the full audit date');
});

test('refetches after a legacy map cursor and resumes the rebuilt checkpoint after reload', async () => {
  const imported = makeSession('legacy-map');
  const older = makeSession('skipped-older-timestamp');
  const newer = makeSession('skipped-newer-timestamp');
  const legacy = cursor(900_000, imported.sessionId, 10);
  const first = cursor(20, older.sessionId, 931);
  const last = cursor(20, newer.sessionId, 932);
  await hydrateRemoteReadingSessionsPageV12(owner, [imported], null, legacy, true, false, [], 10_000);
  const db = await initDB();
  const meta = await db.get(V12_READING_STATISTICS_SYNC_STORE, owner);
  delete meta.cursorVersion;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, meta);

  await closeLocalDB();
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, 11_000), {
    reason: 'legacy-cursor', legacyCursor: legacy,
  });
  await hydrateRemoteReadingSessionsPageV12(owner, [older], null, first, false, false, [], 11_000);
  await closeLocalDB();
  const resume = await getReadingStatisticsHydrationPlanV12(owner, 12_000);
  assert.equal(resume.fullAuditInProgress, true);
  assert.deepEqual(resume.state.cursor, first);
  const quarantine = { documentId: imported.sessionId, reason: 'malformed timestamp', detectedAt: 12_000 };
  await hydrateRemoteReadingSessionsPageV12(
    owner, [newer], resume.state.cursor, last, true, false, [quarantine], 12_000,
  );
  const completed = await getReadingStatisticsHydrationPlanV12(owner, 13_000);
  assert.equal(completed.fullAuditInProgress, false);
  assert.deepEqual(completed.state.cursor, last);
  assert.deepEqual(completed.state.quarantinedDocuments, [quarantine]);
  assert.deepEqual((await getLocalReadingSessionsV11(owner)).map(({ sessionId }) => sessionId).sort(), [
    imported.sessionId, newer.sessionId, older.sessionId,
  ].sort());
});

test('adopts an exact legacy cursor only under the current lease and preserves the full audit state', async () => {
  const record = makeSession('legacy-valid');
  const exact = cursor(20, record.sessionId, 931);
  await hydrateRemoteReadingSessionsPageV12(owner, [record], null, exact, false, false, [], 100);
  const db = await initDB();
  const legacyMeta = {
    ...await db.get(V12_READING_STATISTICS_SYNC_STORE, owner),
    lastFullAuditAt: 50,
    lastVerifiedAuditAt: 80,
    hydrationRunCount: 9,
  };
  delete legacyMeta.cursorVersion;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, legacyMeta);
  const plan = await getReadingStatisticsHydrationPlanV12(owner, 150);
  assert.deepEqual(plan, { reason: 'legacy-cursor', legacyCursor: exact });

  const stale = await acquireReadingStatisticsSyncLeaseV13(owner, 'old-tab', 100, 50);
  const current = await acquireReadingStatisticsSyncLeaseV13(owner, 'new-tab', 151, 50);
  assert.equal(await adoptLegacyReadingStatisticsCursorV12(owner, exact, stale, () => 152), false);
  assert.equal(await adoptLegacyReadingStatisticsCursorV12(
    owner, { ...exact, uploadedAtServerNanoseconds: 930 }, current, () => 152,
  ), false);
  assert.deepEqual(await db.get(V12_READING_STATISTICS_SYNC_STORE, owner), legacyMeta);

  assert.equal(await adoptLegacyReadingStatisticsCursorV12(owner, exact, current, () => 152), true);
  assert.equal(await adoptLegacyReadingStatisticsCursorV12(owner, exact, current, () => 152), false);
  assert.deepEqual(await db.get(V12_READING_STATISTICS_SYNC_STORE, owner), { ...legacyMeta, cursorVersion: 1 });
  await closeLocalDB();
  const resumed = await getReadingStatisticsHydrationPlanV12(owner, 153);
  assert.deepEqual(resumed.state.cursor, exact);
  assert.equal(resumed.fullAuditInProgress, true);
  assert.equal(resumed.state.lastFullAuditAt, 50);
});

test('a legacy empty sentinel requires an authoritative scan', async () => {
  await hydrateRemoteReadingSessionsPageV12(owner, [], null, null, true, false, [], 100);
  const db = await initDB();
  const legacy = await db.get(V12_READING_STATISTICS_SYNC_STORE, owner);
  delete legacy.cursorVersion;
  await db.put(V12_READING_STATISTICS_SYNC_STORE, legacy);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, 101), { reason: 'legacy-cursor' });
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'legacy-empty', 101);
  assert.equal(await adoptLegacyReadingStatisticsCursorV12(owner, cursor(0, '__empty__'), lease, () => 102), false);
  assert.deepEqual(await db.get(V12_READING_STATISTICS_SYNC_STORE, owner), legacy);
});

test('keeps an over-128-character malformed document ID as the exact hydration cursor', async () => {
  const longDocumentId = `malformed-${'x'.repeat(180)}`;
  const nextCursor = cursor(31, longDocumentId, 456);
  const quarantined = [{
    documentId: longDocumentId,
    reason: 'schema mismatch',
    detectedAt: 41_000,
  }];
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [],
    null,
    nextCursor,
    true,
    true,
    quarantined,
    51_000,
  );
  const hydration = await getReadingStatisticsHydrationStateV12(owner, 51_000);
  assert.deepEqual(hydration?.cursor, nextCursor);
  assert.deepEqual(hydration?.quarantinedDocuments, quarantined);
});

test('restarts from the beginning for a periodic full audit and preserves an interrupted audit cursor', async () => {
  const first = makeSession('audit-first');
  const firstCursor = cursor(40, first.sessionId, 9);
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [first],
    null,
    firstCursor,
    false,
    true,
    [],
    100_000,
  );
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner, 999_999_999))?.cursor, firstCursor);

  const second = { ...makeSession('audit-second'), startedAtClient: 62_000, endedAtClient: 122_000 };
  const secondCursor = cursor(50, second.sessionId, 10);
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [second],
    firstCursor,
    secondCursor,
    true,
    true,
    [],
    200_000,
  );
  assert.equal(await getReadingStatisticsHydrationStateV12(owner, 200_000 + 7 * 24 * 60 * 60_000), null);
});

test('weekly audits preserve the exact cursor and never postpone the four-week full scan', async () => {
  const fullAt = 200_000;
  const week = 7 * 24 * 60 * 60_000;
  const record = makeSession('audit-verified');
  const exact = cursor(60, record.sessionId, 931);
  await hydrateRemoteReadingSessionsPageV12(owner, [record], null, exact, true, true, [], fullAt);
  const firstCheck = fullAt + week;
  assert.equal(await getReadingStatisticsHydrationStateV12(owner, firstCheck), null);
  const candidate = (await getReadingStatisticsHydrationPlanV12(owner, firstCheck)).candidate;
  assert.deepEqual(candidate.cursor, exact);
  assert.equal(candidate.remoteCount, 1);
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'verified-audit', firstCheck);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => firstCheck), true);
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner, firstCheck)).cursor, exact);
  assert.equal((await getReadingStatisticsHydrationStateV12(owner, firstCheck)).lastFullAuditAt, fullAt);

  const lateCheck = fullAt + 4 * week - 1_000;
  const lateCandidate = (await getReadingStatisticsHydrationPlanV12(owner, lateCheck)).candidate;
  const lateLease = await acquireReadingStatisticsSyncLeaseV13(owner, 'verified-audit', lateCheck);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, lateCandidate, lateLease, () => lateCheck), true);
  assert.equal(await getReadingStatisticsHydrationStateV12(owner, fullAt + 4 * week), null);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, fullAt + 4 * week), {
    reason: 'periodic-full-audit',
  });
});

test('a pending replacement and a lease takeover cannot certify a weekly audit', async () => {
  const fullAt = 200_000;
  const checkAt = fullAt + 7 * 24 * 60 * 60_000;
  const first = makeSession('audit-lost');
  const latest = makeSession('audit-latest');
  const exact = cursor(60, latest.sessionId, 931);
  await hydrateRemoteReadingSessionsPageV12(owner, [first, latest], null, exact, true, true, [], fullAt);
  const candidate = (await getReadingStatisticsHydrationPlanV12(owner, checkAt)).candidate;
  assert.ok(candidate);

  const oldLease = await acquireReadingStatisticsSyncLeaseV13(owner, 'old', checkAt, 10);
  const times = [checkAt, checkAt + 11];
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, oldLease, () => times.shift()), false);
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'new', checkAt + 11);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, oldLease, () => checkAt + 11), false);

  await (await initDB()).delete(V11_READING_SESSIONS_STORE, [owner, first.sessionId]);
  await saveLocalReadingSessionV11(owner, makeSession('unconfirmed-replacement'));
  assert.equal((await getLocalReadingSessionsV11(owner)).length, 2);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => checkAt + 12), false);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt + 12), {
    reason: 'local-synced-count-behind',
  });

  await hydrateRemoteReadingSessionsPageV12(owner, [first, latest], null, exact, true, true, [], checkAt + 12, lease);
  assert.ok((await getLocalReadingSessionsV11(owner)).some((entry) => entry.sessionId === first.sessionId));
});

test('a short incremental page reconciles an acknowledged upload before weekly verification', async () => {
  const fullAt = 200_000;
  const checkAt = fullAt + 7 * 24 * 60 * 60_000;
  const previous = makeSession('already-received');
  const uploaded = makeSession('newly-uploaded');
  const newest = makeSession('other-device');
  const previousCursor = cursor(60, previous.sessionId, 930);
  const newestCursor = cursor(60, newest.sessionId, 932);
  await hydrateRemoteReadingSessionsPageV12(owner, [previous], null, previousCursor, true, true, [], fullAt);
  await saveLocalReadingSessionV11(owner, uploaded);
  assert.equal(await markReadingSessionSyncedV11(owner, uploaded.sessionId, uploaded), true);
  const plan = await getReadingStatisticsHydrationPlanV12(owner, checkAt);
  assert.deepEqual(plan, {
    reason: 'local-synced-count-ahead',
    catchUpFrom: {
      cursor: previousCursor, remoteCount: 1, quarantinedDocumentIds: [],
      lastFullAuditAt: fullAt, lastVerifiedAuditAt: 0,
    },
  });
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'catch-up', checkAt);
  const hydrated = await catchUpReadingStatisticsAuditAsLeader(plan.catchUpFrom.cursor, {
    isLeader: () => true,
    verifyPreviousRange: async () => true,
    fetchPage: async (from) => {
      assert.deepEqual(from, previousCursor);
      return { sessions: [uploaded, newest], nextCursor: newestCursor, fullHydrationCompleted: true, quarantinedDocuments: [] };
    },
    commitPage: (page, from) => hydrateRemoteReadingSessionsPageV12(
      owner, page.sessions, from, page.nextCursor, page.fullHydrationCompleted, false, [], checkAt, lease,
    ),
  });
  assert.equal(hydrated, 2);
  const candidate = (await getReadingStatisticsHydrationPlanV12(owner, checkAt)).candidate;
  assert.equal(candidate.remoteCount, 3);
  assert.deepEqual(candidate.cursor, newestCursor);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => checkAt), true);
  assert.equal((await getReadingStatisticsHydrationStateV12(owner, checkAt)).lastFullAuditAt, fullAt);
});

test('catch-up exposes a missing older session even when excess uploads masked the loss', async () => {
  const fullAt = 200_000;
  const checkAt = fullAt + 7 * 24 * 60 * 60_000;
  const first = makeSession('missing');
  const last = makeSession('last');
  const uploaded = [makeSession('upload-a'), makeSession('upload-b')];
  const checkpoint = cursor(60, last.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [first, last], null, checkpoint, true, true, [], fullAt);
  await (await initDB()).delete(V11_READING_SESSIONS_STORE, [owner, first.sessionId]);
  for (const record of uploaded) {
    await saveLocalReadingSessionV11(owner, record);
    await markReadingSessionSyncedV11(owner, record.sessionId, record);
  }
  await saveLocalReadingSessionV11(owner, makeSession('pending-replacement'));
  const plan = await getReadingStatisticsHydrationPlanV12(owner, checkAt);
  assert.equal(plan.reason, 'local-synced-count-ahead');
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'catch-up-loss', checkAt);
  await hydrateRemoteReadingSessionsPageV12(owner, uploaded, plan.catchUpFrom.cursor,
    cursor(60, uploaded.at(-1).sessionId, 1), true, false, [], checkAt, lease);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt), { reason: 'local-synced-count-behind' });
});

test('a quarantine at the cursor can be audited while the 28-day recovery stays due', async () => {
  const fullAt = 200_000;
  const week = 7 * 24 * 60 * 60_000;
  const checkAt = fullAt + week;
  const known = makeSession('previous');
  const exact = cursor(60, 'quarantined-marker', 931);
  const quarantined = [
    { documentId: 'earlier-quarantine', reason: 'schema mismatch', detectedAt: fullAt },
    { documentId: exact.documentId, reason: 'schema mismatch', detectedAt: fullAt },
  ];
  await hydrateRemoteReadingSessionsPageV12(owner, [known], null, exact, true, true, quarantined, fullAt);
  const candidate = (await getReadingStatisticsHydrationPlanV12(owner, checkAt)).candidate;
  assert.equal(candidate.remoteCount, 3);
  assert.deepEqual(candidate.quarantinedDocumentIds, quarantined.map(({ documentId }) => documentId));
  assert.deepEqual(candidate.cursor, exact);

  const db = await initDB();
  const original = await db.get(V12_READING_STATISTICS_SYNC_STORE, owner);
  await db.put(V12_READING_STATISTICS_SYNC_STORE, {
    ...original, quarantinedDocuments: [{ ...quarantined[0], documentId: 'changed-quarantine' }, quarantined[1]],
  });
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, checkAt)).candidate.remoteCount, candidate.remoteCount);
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'quarantine-audit', checkAt);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => checkAt), false);
  await db.put(V12_READING_STATISTICS_SYNC_STORE, original);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => checkAt), true);
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner, checkAt)).quarantinedDocuments, quarantined);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, fullAt + 4 * week), { reason: 'periodic-full-audit' });
});

test('a verified publication audit defers raw rehydration but preserves the raw cursor and rollback schedule', async () => {
  const fullAt = 200_000;
  const week = 7 * 24 * 60 * 60_000;
  const checkAt = fullAt + 4 * week;
  const previous = makeSession('published-marker');
  const exact = cursor(60, previous.sessionId, 20);
  await hydrateRemoteReadingSessionsPageV12(owner, [previous], null, exact, true, false, [], fullAt);

  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt), { reason: 'periodic-full-audit' });
  const { candidate } = await getReadingStatisticsHydrationPlanV12(owner, checkAt, true);
  assert.equal(candidate.publishedAudit, true);
  assert.deepEqual(candidate.cursor, exact);
  const lease = await acquireReadingStatisticsSyncLeaseV13(owner, 'published-audit', checkAt);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(owner, candidate, lease, () => checkAt), true);

  const future = makeSession('open-period-upload');
  const newer = cursor(60, future.sessionId, 21);
  await hydrateRemoteReadingSessionsPageV12(owner, [future], exact, newer, true, false, [], checkAt, lease, true);
  const incremental = await getReadingStatisticsHydrationPlanV12(owner, checkAt + week - 1, true);
  assert.deepEqual(incremental.state.cursor, newer);
  assert.equal(incremental.state.lastFullAuditAt, fullAt);
  assert.equal((await getReadingStatisticsHydrationPlanV12(owner, checkAt + week, true)).candidate.publishedAudit, true);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt + week - 1), { reason: 'periodic-full-audit' });

  const db = await initDB();
  await db.delete(V11_READING_SESSIONS_STORE, [owner, previous.sessionId]);
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt + 1, true), { reason: 'local-history-missing' });
  const newDevice = makeOwnerKey(makeFirebaseOwnerKey('other-published'), 'library:local');
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(newDevice, checkAt + 1, true), { reason: 'initial-history' });
});

test('a malformed local copy cannot block recovery or make a full scan reread the same page', async () => {
  const fullAt = 200_000;
  const checkAt = fullAt + 7 * 24 * 60 * 60_000;
  const session = makeSession('audit-damaged');
  const exact = cursor(61, session.sessionId, 932);
  await hydrateRemoteReadingSessionsPageV12(owner, [session], null, exact, true, true, [], fullAt);
  const db = await initDB();
  const damaged = await db.get(V11_READING_SESSIONS_STORE, [owner, session.sessionId]);
  await db.put(V11_READING_SESSIONS_STORE, { ...damaged, durationMs: -1 });
  assert.deepEqual(await getReadingStatisticsHydrationPlanV12(owner, checkAt), {
    reason: 'local-cursor-invalid',
  });

  await hydrateRemoteReadingSessionsPageV12(owner, [session], null, exact, true, true, [], checkAt);
  assert.equal((await getLocalReadingSessionsV11(owner))[0].durationMs, session.durationMs);
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner, checkAt + 60_000)).cursor, exact);
});

test('fences hydration and upload acknowledgement inside the current lease transaction', async () => {
  const oldLease = await acquireReadingStatisticsSyncLeaseV13(
    owner,
    'tab-old',
    100,
    50,
  );
  const currentLease = await acquireReadingStatisticsSyncLeaseV13(
    owner,
    'tab-current',
    151,
    50,
  );
  const record = makeSession('lease-fenced');
  const remoteCursor = cursor(60, record.sessionId);

  await assert.rejects(hydrateRemoteReadingSessionsPageV12(
    owner,
    [record],
    null,
    remoteCursor,
    true,
    false,
    [],
    152,
    oldLease,
  ), /lease/);
  assert.equal((await getLocalReadingSessionsV11(owner)).length, 0);

  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [record],
    null,
    remoteCursor,
    true,
    false,
    [],
    152,
    currentLease,
  );
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner, 152))?.cursor, remoteCursor);

  const pending = makeSession('lease-upload');
  await saveLocalReadingSessionV11(owner, pending);
  assert.equal(await markReadingSessionSyncedV11(
    owner,
    pending.sessionId,
    pending,
    oldLease,
    152,
  ), false);
  assert.equal((await getLocalReadingSessionsV11(owner)).find(
    ({ sessionId }) => sessionId === pending.sessionId,
  )?.syncState, 'pending');
  assert.equal(await markReadingSessionSyncedV11(
    owner,
    pending.sessionId,
    pending,
    currentLease,
    152,
  ), true);
});
