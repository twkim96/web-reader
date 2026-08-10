import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';

const { closeLocalDB, initDB } = await import('../src/lib/localDB.ts');
const {
  LOCAL_DB_NAME,
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V8_ANNOTATIONS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
  V11_READING_SESSIONS_STORE,
} = await import('../src/lib/localDBSchema.ts');
const {
  getReadingStatisticsHydrationMetricsV12,
  hydrateRemoteReadingSessionsPageV12,
  recordReadingStatisticsHydrationMetricsV12,
  saveLocalReadingSessionV11,
} = await import('../src/lib/localReadingStatistics.ts');
const {
  collectStorageMaintenanceDiagnosticsV1,
  planStorageMaintenanceMigrationV1,
} = await import('../src/lib/storageMaintenanceDiagnostics.ts');
const { makeFirebaseOwnerKey, makeOwnerKey } = await import('../src/lib/ownerIdentity.ts');

const owner = makeOwnerKey(makeFirebaseOwnerKey('maintenance'), 'library:local');
const DAY_MS = 24 * 60 * 60_000;
const now = 200 * DAY_MS;

const readingSession = {
  schemaVersion: 1,
  sessionId: 'session-1',
  bookId: 'book-1',
  bookTitle: 'Book',
  deviceId: 'device-1',
  mode: 'screen',
  startedAtClient: now - 40 * DAY_MS,
  endedAtClient: now - 40 * DAY_MS + 60_000,
  durationMs: 60_000,
  startProgressPercent: 10,
  endProgressPercent: 11,
  localDate: '1970-06-10',
  timezoneOffsetMinutes: 0,
  completed: false,
};

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

test.beforeEach(resetDatabase);
test.after(resetDatabase);

test('collects bounded owner diagnostics without deleting retention candidates', async () => {
  await saveLocalReadingSessionV11(owner, readingSession);
  await hydrateRemoteReadingSessionsPageV12(
    owner,
    [readingSession],
    null,
    { uploadedAtServerSeconds: 1, uploadedAtServerNanoseconds: 0, documentId: 'session-1' },
    true,
    false,
    [],
    now,
  );
  await recordReadingStatisticsHydrationMetricsV12(owner, {
    pageCount: 2,
    remoteReadCount: 3,
    durationMs: 12.5,
    completedAt: now,
  });
  const db = await initDB();
  await db.put(V5_OUTBOX_STORE, {
    ownerKey: owner,
    eventId: 'superseded-old',
    target: { kind: 'progress', bookId: 'book-1' },
    targetKey: 'progress:book-1',
    operation: 'progress.reset',
    payload: null,
    deviceId: 'device-1',
    sessionId: 'session-1',
    sequence: 1,
    baseRevision: 0,
    occurredAtClient: now - 31 * DAY_MS,
    status: 'superseded',
    attempts: 0,
    nextAttemptAt: null,
    lastErrorCode: null,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  });
  await db.put(V5_SYNC_CONFLICTS_STORE, {
    ownerKey: owner,
    conflictId: 'resolved-old',
    targetKey: 'progress:book-1',
    state: 'resolved_remote',
    event: null,
    remoteHead: null,
    latestLocalPosition: null,
    blockedEventIds: [],
    createdAt: now - 35 * DAY_MS,
    resolvedAt: now - 31 * DAY_MS,
  });
  await db.put(V5_REMOTE_HEADS_STORE, {
    ownerKey: owner,
    targetKey: 'progress:book-1',
    revision: 1,
    head: {
      schemaVersion: 2,
      bookId: 'book-1',
      revision: 1,
      acceptedEventId: 'event-remote',
      operation: 'reset',
      position: null,
      acceptedDeviceId: 'device-remote',
      occurredAtClient: 1,
      updatedAtServer: {},
      deletedAtServer: {},
    },
    updatedAt: now,
  });
  await db.put(V8_ANNOTATIONS_STORE, {
    ownerKey: owner,
    bookId: 'book-1',
    id: 'annotation-1',
    anchorState: 'unresolved',
  });
  await db.put(V10_ANNOTATION_BOOK_DELETIONS_STORE, {
    ownerKey: owner,
    bookId: 'deleted-book',
  });

  let monotonic = 0;
  const diagnostics = await collectStorageMaintenanceDiagnosticsV1(owner, {
    now,
    monotonicNow: () => monotonic += 1,
    estimateStorage: async () => ({ usage: 250, quota: 1_000 }),
  });
  assert.equal(diagnostics.outbox.count, 1);
  assert.equal(diagnostics.outbox.supersededOlderThan30Days, 1);
  assert.equal(diagnostics.conflicts.resolvedOlderThan30Days, 1);
  assert.equal(diagnostics.annotations.unresolvedCount, 1);
  assert.equal(diagnostics.annotations.bookDeletionMarkerCount, 1);
  assert.equal(diagnostics.remoteHeads.tombstoneCount, 1);
  assert.equal(diagnostics.remoteHeads.receiptCount, null);
  assert.equal(diagnostics.readingStatistics.rawSessionCount, 1);
  assert.equal(diagnostics.readingStatistics.malformedRecordCount, 0);
  assert.equal(diagnostics.readingStatistics.byMonth['1970-06'], 1);
  assert.deepEqual(diagnostics.readingStatistics.hydration, {
    runCount: 1,
    pageCount: 2,
    remoteReadAttemptCount: 3,
    remoteReadCount: 3,
    lostLeadershipRunCount: 0,
    failedRunCount: 0,
    lastDurationMs: 12.5,
    lastCompletedAt: now,
  });
  assert.equal(diagnostics.quota.ratio, 0.25);

  assert.equal((await db.getAll(V5_OUTBOX_STORE)).length, 1);
  assert.equal((await db.getAll(V5_SYNC_CONFLICTS_STORE)).length, 1);
});

test('reports malformed local reading sessions without aborting diagnostics', async () => {
  await saveLocalReadingSessionV11(owner, readingSession);
  const db = await initDB();
  await db.put(V11_READING_SESSIONS_STORE, {
    ownerKey: owner,
    sessionId: 'malformed-session',
    syncState: 'pending',
    localDate: undefined,
  });

  const diagnostics = await collectStorageMaintenanceDiagnosticsV1(owner, {
    now,
    estimateStorage: async () => ({}),
  });
  assert.equal(diagnostics.readingStatistics.rawSessionCount, 2);
  assert.equal(diagnostics.readingStatistics.malformedRecordCount, 1);
  assert.equal(diagnostics.readingStatistics.byMonth['1970-06'], 1);
  assert.equal(diagnostics.readingStatistics.bySyncState.pending, 2);
});

test('keeps migration observe-only until every offline and rollback proof exists', () => {
  const incomplete = planStorageMaintenanceMigrationV1({
    maximumOfflineDaysTested: 30,
    authoritativeSnapshotEquivalent: true,
    readingStatisticsTotalsEquivalent: true,
    rollbackPassed: false,
    legacyClientReconnectPassed: false,
  });
  assert.equal(incomplete.status, 'observe-only');
  assert.equal(incomplete.automaticDeletionEnabled, false);
  assert.match(incomplete.blockers.join('\n'), /90일/);
  assert.match(incomplete.blockers.join('\n'), /rollback/);

  const ready = planStorageMaintenanceMigrationV1({
    maximumOfflineDaysTested: 90,
    authoritativeSnapshotEquivalent: true,
    readingStatisticsTotalsEquivalent: true,
    rollbackPassed: true,
    legacyClientReconnectPassed: true,
  });
  assert.equal(ready.status, 'migration-ready');
  assert.equal(ready.automaticDeletionEnabled, false);
  assert.deepEqual(ready.blockers, []);
});

test('rejects impossible hydration read metrics', async () => {
  assert.equal(await getReadingStatisticsHydrationMetricsV12(owner), null);
  assert.equal(await recordReadingStatisticsHydrationMetricsV12(owner, {
    pageCount: 1,
    remoteReadAttemptCount: 2,
    remoteReadCount: 2,
    durationMs: 1,
  }), true);
  await assert.rejects(recordReadingStatisticsHydrationMetricsV12(owner, {
    pageCount: 2,
    remoteReadCount: 1,
    durationMs: 1,
  }), /계측값/);
});
