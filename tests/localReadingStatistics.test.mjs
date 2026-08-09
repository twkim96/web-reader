import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { closeLocalDB, initDB } from '../src/lib/localDB.ts';
import {
  LOCAL_DB_NAME,
  LOCAL_DB_VERSION,
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
} from '../src/lib/localDBSchema.ts';
import {
  deferReadingSessionSyncV11,
  getReadingStatisticsHydrationStateV12,
  getLocalReadingSessionsV11,
  getPendingReadingSessionsV11,
  hydrateRemoteReadingSessionsPageV12,
  saveLocalReadingSessionV11,
} from '../src/lib/localReadingStatistics.ts';
import { getReadingStatisticsDraftKey } from '../src/lib/readingStatisticsDraft.ts';
import {
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
} from '../src/lib/ownerIdentity.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';

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

test('discards a surviving cursor when the raw session store was cleared', async () => {
  const record = makeSession('remote-cleared');
  const remoteCursor = cursor(20, record.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [record], null, remoteCursor, true);
  const db = await initDB();
  const tx = db.transaction(V11_READING_SESSIONS_STORE, 'readwrite');
  await tx.objectStore(V11_READING_SESSIONS_STORE).clear();
  await tx.done;
  assert.equal(await getReadingStatisticsHydrationStateV12(owner), null);
});

test('does not advance hydration cursor when a page collides', async () => {
  const first = makeSession('remote-collision');
  const cursor1 = cursor(10, first.sessionId);
  await hydrateRemoteReadingSessionsPageV12(owner, [first], null, cursor1, false);
  const cursor2 = cursor(20, 'next');
  await assert.rejects(
    hydrateRemoteReadingSessionsPageV12(
      owner,
      [{ ...first, bookTitle: 'Collision' }],
      cursor1,
      cursor2,
      true,
    ),
    /충돌/,
  );
  assert.deepEqual((await getReadingStatisticsHydrationStateV12(owner))?.cursor, cursor1);
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
