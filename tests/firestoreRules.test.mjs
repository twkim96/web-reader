import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  collection,
  documentId,
  endAt,
  getCountFromServer,
  getDoc,
  getDocFromServer,
  getDocs,
  getDocsFromServer,
  limit,
  limitToLast,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  startAt,
  Timestamp,
  writeBatch,
} from 'firebase/firestore';
import { applyProgressEventTransaction } from '../src/lib/progressSyncTransaction.ts';
import { applyBookmarkEventTransaction } from '../src/lib/bookmarkSyncTransaction.ts';
import {
  applyAnnotationEventTransaction,
  applyAnnotationPaletteEventTransaction,
} from '../src/lib/annotationSyncTransaction.ts';
import { prepareWriteLease, createSyncEventId } from '../src/lib/writeLeaseTransport.ts';
import { parseLeasedEventId } from '../src/lib/writeLeasePolicy.ts';
import { DEFAULT_ANNOTATION_PALETTE } from '../src/lib/annotationPalette.ts';
import { closeLocalDB, initDB } from '../src/lib/localDB.ts';
import { V12_READING_STATISTICS_SYNC_STORE } from '../src/lib/localDBSchema.ts';
import {
  adoptLegacyReadingStatisticsCursorV12,
  getReadingStatisticsHydrationPlanV12,
  hydrateRemoteReadingSessionsPageV12,
  recordReadingStatisticsVerifiedAuditV12,
} from '../src/lib/localReadingStatistics.ts';
import { makeFirebaseOwnerKey, makeOwnerKey } from '../src/lib/ownerIdentity.ts';
import {
  getRemoteReadingSessionsPageV1,
  uploadReadingSessionV1,
  verifyLegacyReadingStatisticsCursorV1,
  verifyRemoteReadingStatisticsAuditV1,
} from '../src/lib/readingStatisticsSync.ts';
import { acquireReadingStatisticsSyncLeaseV13 } from '../src/lib/readingStatisticsSyncLease.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';

const projectId = 'demo-web-reader';
const appId = 'private-web-novel-viewer';
let environment;
let fixtureIssued;
const fixtureLeaseId = '1af12345-1234-4123-8123-123456789abc';
const fixtureEvent = (label) => {
  if (label.startsWith('wl1_')) return label;
  const hash = createHash('sha256').update(label).digest('hex');
  const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return `wl1_${fixtureLeaseId}_${fixtureIssued}_${uuid}`;
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

after(async () => {
  await environment?.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  fixtureIssued = Date.now() - 1000;
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `artifacts/${appId}/users/alice/libraries/local/writeLeases/${fixtureLeaseId}`), {
      schemaVersion: 1, deviceId: 'device-1', issuedAtServer: Timestamp.fromMillis(fixtureIssued),
    });
  });
});

test('clients cannot access staged rollups, operation leases, or private publication pointers', async () => {
  const base = `artifacts/${appId}`;
  const job = `${base}/readingStatsRollupJobsV1/alice`;
  const paths = [
    job, `${job}/readingStatsRollupWeeksV1/2026-09-14`,
    `${job}/readingStatsRollupCalendarsV1/2026-11-16`, `${job}/readingStatsRollupManifestsV1/current`,
    `${job}/readingStatsRollupFilesV1/current`,
    `${base}/readingStatsRollupLeasesV1/alice`, `${base}/readingStatsRollupBudgetsV1/2026-11-24`,
  ];
  await environment.withSecurityRulesDisabled(async (context) => {
    await Promise.all(paths.map((path) => setDoc(doc(context.firestore(), path), { value: 1 })));
  });
  const db = environment.authenticatedContext('alice').firestore();
  for (const path of paths) {
    const ref = doc(db, path);
    await assertFails(getDocFromServer(ref));
    await assertFails(setDoc(ref, { value: 2 }));
  }
});

const database = (uid = 'alice') => environment
  .authenticatedContext(uid)
  .firestore();

const publicBookMetadataPath = 'publicBookMetadataV1/ab';
const publicBookCatalogPath = 'publicBookCatalogIndexV1/manifest';
const publicBookOnDemandPath = `publicBookMetadataOnDemandV1/${'a'.repeat(64)}`;
const publicBookDeltaPath = 'publicBookCatalogDeltaV1/manifest';

const validPublicBookMetadata = () => ({
  schemaVersion: 1,
  titleKey: '작품',
  displayTitle: '작품',
  normalizerVersion: '1.3.3',
  publishedAt: '2026-08-14T00:00:00+00:00',
  entries: {},
});

test('allows public metadata reads but blocks every client write', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), publicBookMetadataPath), validPublicBookMetadata());
  });
  await assertSucceeds(getDoc(doc(database(), publicBookMetadataPath)));
  await assertSucceeds(getDoc(doc(environment.unauthenticatedContext().firestore(), publicBookMetadataPath)));
  await assertFails(getDocs(collection(database(), 'publicBookMetadataV1')));
  await assertFails(setDoc(doc(database(), publicBookMetadataPath), validPublicBookMetadata()));
  await assertFails(deleteDoc(doc(database(), publicBookMetadataPath)));
});

test('allows public catalog point reads but blocks list and client writes', async () => {
  const manifest = {
    schemaVersion: 1,
    generation: '0123456789abcdefabcd',
    publishedAt: '2026-08-17T00:00:00+00:00',
  };
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), publicBookCatalogPath), manifest);
  });
  await assertSucceeds(getDoc(doc(database(), publicBookCatalogPath)));
  await assertSucceeds(getDoc(doc(
    environment.unauthenticatedContext().firestore(),
    publicBookCatalogPath,
  )));
  await assertFails(getDocs(collection(database(), 'publicBookCatalogIndexV1')));
  await assertFails(setDoc(doc(database(), publicBookCatalogPath), manifest));
  await assertFails(deleteDoc(doc(database(), publicBookCatalogPath)));
});

test('allows on-demand metadata and delta point reads but blocks list and client writes', async () => {
  const value = { schemaVersion: 1 };
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), publicBookOnDemandPath), value);
    await setDoc(doc(context.firestore(), publicBookDeltaPath), value);
  });
  for (const [path, collectionName] of [
    [publicBookOnDemandPath, 'publicBookMetadataOnDemandV1'],
    [publicBookDeltaPath, 'publicBookCatalogDeltaV1'],
  ]) {
    await assertSucceeds(getDoc(doc(environment.unauthenticatedContext().firestore(), path)));
    await assertFails(getDocs(collection(database(), collectionName)));
    await assertFails(setDoc(doc(database(), path), value));
    await assertFails(deleteDoc(doc(database(), path)));
  }
});

test('keeps point-read book metadata and catalogs exempt from automatic field indexes', async () => {
  const config = JSON.parse(await readFile('firestore.indexes.json', 'utf8'));
  assert.deepEqual(config.indexes.filter(({ collectionGroup }) => collectionGroup.startsWith('publicBook')), []);
  assert.deepEqual(config.fieldOverrides.filter(({ collectionGroup }) => collectionGroup.startsWith('publicBook')).map(({ collectionGroup }) => collectionGroup), [
    'publicBookMetadataV1',
    'publicBookCatalogIndexV1',
    'publicBookCatalogDeltaV1',
    'publicBookMetadataOnDemandV1',
  ]);
  for (const override of config.fieldOverrides.filter(({ collectionGroup }) => collectionGroup.startsWith('publicBook'))) {
    assert.equal(override.fieldPath, '*');
    assert.deepEqual(override.indexes, []);
  }
});

test('defines the collection index used by the bounded public wishlist feed', async () => {
  const config = JSON.parse(await readFile('firestore.indexes.json', 'utf8'));
  assert.ok(config.indexes.some(({ collectionGroup, queryScope, fields }) =>
    collectionGroup === 'myPageWishlistV1' && queryScope === 'COLLECTION'
    && JSON.stringify(fields) === JSON.stringify([
      { fieldPath: 'saved', order: 'ASCENDING' },
      { fieldPath: 'addedAt', order: 'DESCENDING' },
      { fieldPath: 'workId', order: 'ASCENDING' },
    ])));
});

const progressPath = (uid = 'alice') => (
  `artifacts/${appId}/users/${uid}/libraries/local/readingHistoryV2/book-1`
);

const readingStatisticsPath = (sessionId = 'stats-session-1', uid = 'alice') => (
  `artifacts/${appId}/users/${uid}/libraries/local/readingStatsV1/${sessionId}`
);

const validReadingSession = (sessionId = 'stats-session-1') => ({
  schemaVersion: 1,
  sessionId,
  bookId: 'book-1',
  bookTitle: 'Book One',
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

const validHead = (eventId = fixtureEvent('event-1'), revision = 1) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  revision,
  acceptedEventId: eventId,
  operation: 'set',
  position: { cfi: 'epubcfi(/6/2)', anchorCfi: null, progressPercent: 25 },
  acceptedDeviceId: 'device-1',
  acceptedSessionId: 'session-1',
  occurredAtClient: 1,
  updatedAtServer: serverTimestamp(),
  deletedAtServer: null,
});

const validReceipt = (eventId = fixtureEvent('event-1'), revision = 1) => ({
  schemaVersion: 2,
  eventId,
  targetKind: 'progress',
  bookId: 'book-1',
  bookmarkId: null,
  targetKey: 'progress:book-1',
  revision,
  createdAtServer: serverTimestamp(),
});

const writeProgressEvent = (db, eventId = fixtureEvent('event-1'), revision = 1) => {
  const batch = writeBatch(db);
  batch.set(doc(db, progressPath()), validHead(eventId, revision));
  batch.set(
    doc(db, `${progressPath()}/eventReceipts/${eventId}`),
    validReceipt(eventId, revision),
  );
  return batch.commit();
};

const bookmarkPath = (bookmarkId = 'mark-1') => (
  `${progressPath()}/bookmarks/${bookmarkId}`
);

const validBookmarkHead = (
  eventId = fixtureEvent('bookmark-event-1'),
  revision = 1,
  operation = 'upsert',
) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  bookmarkId: 'mark-1',
  revision,
  acceptedEventId: eventId,
  operation,
  bookmark: operation === 'upsert' ? {
    bookmarkId: 'mark-1',
    cfi: 'epubcfi(/6/4)',
    name: '중요',
    color: 'yellow',
    progressPercent: 35,
    createdAtClient: 1,
    updatedAtClient: revision,
  } : null,
  acceptedDeviceId: 'device-1',
  acceptedSessionId: 'session-1',
  occurredAtClient: revision,
  updatedAtServer: serverTimestamp(),
  deletedAtServer: operation === 'delete' ? serverTimestamp() : null,
});

const validBookmarkReceipt = (eventId = fixtureEvent('bookmark-event-1'), revision = 1) => ({
  schemaVersion: 2,
  eventId,
  targetKind: 'bookmark',
  bookId: 'book-1',
  bookmarkId: 'mark-1',
  targetKey: 'bookmark:book-1:mark-1',
  revision,
  createdAtServer: serverTimestamp(),
});

const writeBookmarkEvent = (
  db,
  eventId = fixtureEvent('bookmark-event-1'),
  revision = 1,
  operation = 'upsert',
) => {
  const batch = writeBatch(db);
  batch.set(doc(db, bookmarkPath()), validBookmarkHead(eventId, revision, operation));
  batch.set(
    doc(db, `${progressPath()}/eventReceipts/${eventId}`),
    validBookmarkReceipt(eventId, revision),
  );
  return batch.commit();
};

const annotationPath = (annotationId = 'annotation-1') => (
  `artifacts/${appId}/users/alice/libraries/local/annotationSyncV1/book-1/annotations/${annotationId}`
);

const annotationReceiptPath = (eventId) => (
  `artifacts/${appId}/users/alice/libraries/local/annotationSyncV1/book-1/eventReceipts/${eventId}`
);

const annotationAggregatePath = () => (
  `artifacts/${appId}/users/alice/libraries/local/annotationSyncV1/book-1`
);

const validAnnotationPayload = () => ({
  id: 'annotation-1',
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: 'epubcfi(/6/4!/4/2,/1:0,/1:4)',
  quote: '문장',
  prefix: '',
  suffix: '',
  colorId: 'yellow',
  note: '메모',
  progressPercent: 25,
  chapter: '1장',
  createdAtClient: 1,
  updatedAtClient: 2,
});

const validAnnotationHead = (
  eventId = fixtureEvent('annotation-event-1'),
  revision = 1,
  operation = 'upsert',
) => ({
  schemaVersion: 1,
  bookId: 'book-1',
  annotationId: 'annotation-1',
  revision,
  acceptedEventId: eventId,
  operation,
  annotation: operation === 'upsert' ? validAnnotationPayload() : null,
  acceptedDeviceId: 'device-1',
  acceptedSessionId: 'session-1',
  occurredAtClient: revision,
  updatedAtServer: serverTimestamp(),
  deletedAtServer: operation === 'delete' ? serverTimestamp() : null,
});

const validAnnotationReceipt = (eventId = fixtureEvent('annotation-event-1'), revision = 1) => ({
  schemaVersion: 1,
  eventId,
  targetKind: 'annotation',
  bookId: 'book-1',
  annotationId: 'annotation-1',
  targetKey: 'annotation:book-1:annotation-1',
  revision,
  createdAtServer: serverTimestamp(),
});

const validAnnotationAggregate = (
  eventId = fixtureEvent('annotation-event-1'),
  revision = 1,
  operation = 'upsert',
) => {
  const payload = validAnnotationPayload();
  const active = operation === 'upsert';
  return {
    schemaVersion: 1,
    bookId: 'book-1',
    revision,
    totalCount: active ? 1 : 0,
    colorCounts: {
      yellow: active ? 1 : 0,
      green: 0,
      blue: 0,
      pink: 0,
      purple: 0,
    },
    entries: active ? {
      'annotation-1': { rangeCfi: payload.rangeCfi, colorId: 'yellow' },
    } : {},
    rangeCfis: active ? [payload.rangeCfi] : [],
    acceptedEventId: eventId,
    acceptedAnnotationId: 'annotation-1',
    acceptedOperation: operation,
    updatedAtServer: serverTimestamp(),
  };
};

const writeAnnotationEvent = (
  db,
  eventId = fixtureEvent('annotation-event-1'),
  revision = 1,
  operation = 'upsert',
) => {
  const batch = writeBatch(db);
  batch.set(doc(db, annotationPath()), validAnnotationHead(eventId, revision, operation));
  batch.set(
    doc(db, annotationAggregatePath()),
    validAnnotationAggregate(eventId, revision, operation),
  );
  batch.set(
    doc(db, annotationReceiptPath(eventId)),
    validAnnotationReceipt(eventId, revision),
  );
  return batch.commit();
};

const palettePath = () => (
  `artifacts/${appId}/users/alice/libraries/local/annotationSettingsV1/palette`
);

const paletteReceiptPath = (eventId) => `${palettePath()}/eventReceipts/${eventId}`;

const validPaletteHead = (eventId = fixtureEvent('palette-event-1'), revision = 1) => ({
  schemaVersion: 1,
  revision,
  acceptedEventId: eventId,
  operation: 'set',
  palette: { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) },
  acceptedDeviceId: 'device-1',
  acceptedSessionId: 'session-1',
  occurredAtClient: revision,
  updatedAtServer: serverTimestamp(),
});

const validPaletteReceipt = (eventId = fixtureEvent('palette-event-1'), revision = 1) => ({
  schemaVersion: 1,
  eventId,
  targetKind: 'palette',
  bookId: null,
  annotationId: null,
  targetKey: 'annotation-palette',
  revision,
  createdAtServer: serverTimestamp(),
});

const writePaletteEvent = (db, eventId = fixtureEvent('palette-event-1'), revision = 1) => {
  const batch = writeBatch(db);
  batch.set(doc(db, palettePath()), validPaletteHead(eventId, revision));
  batch.set(doc(db, paletteReceiptPath(eventId)), validPaletteReceipt(eventId, revision));
  return batch.commit();
};

const progressEvent = (eventId, progressPercent, baseRevision = 0, operation = 'progress.set') => ({
  ownerKey: 'firebase:alice|library:local',
  eventId,
  target: { kind: 'progress', bookId: 'book-1' },
  targetKey: 'progress:book-1',
  operation,
  payload: operation === 'progress.reset'
    ? null
    : { cfi: `epubcfi(/6/${progressPercent})`, anchorCfi: null, progressPercent },
  deviceId: 'device-1',
  sessionId: `session-${eventId}`,
  sequence: 1,
  baseRevision,
  occurredAtClient: Math.max(1, progressPercent),
  status: 'in_flight',
  attempts: 1,
  nextAttemptAt: 1,
  lastErrorCode: null,
  claimedByTabId: 'tab-1',
  claimedLeaseEpoch: 1,
});

const bookmarkEvent = (eventId, baseRevision = 0, operation = 'bookmark.upsert') => ({
  ownerKey: 'firebase:alice|library:local',
  eventId,
  target: { kind: 'bookmark', bookId: 'book-1', bookmarkId: 'mark-1' },
  targetKey: 'bookmark:book-1:mark-1',
  operation,
  payload: operation === 'bookmark.delete' ? null : {
    bookmarkId: 'mark-1',
    cfi: 'epubcfi(/6/4)',
    name: eventId,
    color: 'yellow',
    progressPercent: 35,
    createdAtClient: 1,
    updatedAtClient: baseRevision + 1,
  },
  deviceId: 'device-1',
  sessionId: `session-${eventId}`,
  sequence: 1,
  baseRevision,
  occurredAtClient: baseRevision + 1,
  status: 'in_flight',
  attempts: 1,
  nextAttemptAt: 1,
  lastErrorCode: null,
  claimedByTabId: 'tab-1',
  claimedLeaseEpoch: 1,
});

const annotationEvent = (
  eventId,
  baseRevision = 0,
  operation = 'annotation.upsert',
) => ({
  eventId,
  target: { kind: 'annotation', bookId: 'book-1', annotationId: 'annotation-1' },
  targetKey: 'annotation:book-1:annotation-1',
  operation,
  payload: operation === 'annotation.delete' ? null : validAnnotationPayload(),
  deviceId: 'device-1',
  sessionId: `session-${eventId}`,
  baseRevision,
  bookGeneration: 0,
  occurredAtClient: baseRevision + 1,
});

const paletteEvent = (eventId, baseRevision = 0) => ({
  eventId,
  target: { kind: 'palette' },
  targetKey: 'annotation-palette',
  operation: 'palette.set',
  payload: { items: DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })) },
  deviceId: 'device-1',
  sessionId: `session-${eventId}`,
  baseRevision,
  occurredAtClient: baseRevision + 1,
});

test('allows own atomic progress head and immutable receipt', async () => {
  const db = database();
  await assertSucceeds(writeProgressEvent(db));
  await assertSucceeds(getDoc(doc(db, progressPath())));
  await assertFails(setDoc(
    doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('event-1')}`),
    validReceipt(fixtureEvent('event-1'), 1),
  ));
  await assertFails(deleteDoc(doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('event-1')}`)));
});

test('rejects another uid and orphan head or receipt writes', async () => {
  await assertFails(getDoc(doc(database('mallory'), progressPath('alice'))));
  await assertFails(setDoc(doc(database(), progressPath()), validHead()));
  await assertFails(setDoc(
    doc(database(), `${progressPath()}/eventReceipts/${fixtureEvent('event-1')}`),
    validReceipt(),
  ));
});

test('rejects revision jumps, unknown fields and invalid progress range', async () => {
  const db = database();
  await assertSucceeds(writeProgressEvent(db));

  const jump = writeBatch(db);
  jump.set(doc(db, progressPath()), validHead(fixtureEvent('event-3'), 3));
  jump.set(doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('event-3')}`), validReceipt(fixtureEvent('event-3'), 3));
  await assertFails(jump.commit());

  const invalid = writeBatch(db);
  invalid.set(doc(db, progressPath()), {
    ...validHead(fixtureEvent('event-2'), 2),
    unknown: true,
    position: { cfi: 'x', anchorCfi: null, progressPercent: 101 },
  });
  invalid.set(doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('event-2')}`), validReceipt(fixtureEvent('event-2'), 2));
  await assertFails(invalid.commit());
});

test('allows atomic bookmark upsert and revisioned tombstone delete', async () => {
  const db = database();
  await assertSucceeds(writeBookmarkEvent(db));
  await assertSucceeds(writeBookmarkEvent(db, fixtureEvent('bookmark-event-2'), 2, 'delete'));
  const snapshot = await assertSucceeds(getDoc(doc(db, bookmarkPath())));
  assert.equal(snapshot.data().operation, 'delete');
  assert.equal(snapshot.data().revision, 2);
  assert.equal(snapshot.data().bookmark, null);
});

test('rejects bookmark identity mismatch, revision jump, and orphan receipt', async () => {
  const db = database();
  await assertSucceeds(writeBookmarkEvent(db));

  const mismatch = writeBatch(db);
  mismatch.set(doc(db, bookmarkPath()), {
    ...validBookmarkHead(fixtureEvent('bookmark-event-2'), 2),
    bookmarkId: 'other-mark',
  });
  mismatch.set(
    doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('bookmark-event-2')}`),
    validBookmarkReceipt(fixtureEvent('bookmark-event-2'), 2),
  );
  await assertFails(mismatch.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, bookmarkPath()), validBookmarkHead(fixtureEvent('bookmark-event-3'), 3));
  jump.set(
    doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('bookmark-event-3')}`),
    validBookmarkReceipt(fixtureEvent('bookmark-event-3'), 3),
  );
  await assertFails(jump.commit());

  await assertFails(setDoc(
    doc(db, `${progressPath()}/eventReceipts/${fixtureEvent('orphan-bookmark-event')}`),
    validBookmarkReceipt(fixtureEvent('orphan-bookmark-event'), 2),
  ));
  await assertFails(getDoc(doc(database('mallory'), bookmarkPath())));
});

test('runs concurrent progress transactions with one winner, receipt replay, reset, and stale conflict', async () => {
  const firstEvent = progressEvent(fixtureEvent('concurrent-a'), 30);
  const secondEvent = progressEvent(fixtureEvent('concurrent-b'), 70);
  const results = await Promise.all([
    applyProgressEventTransaction({
      event: firstEvent,
      uid: 'alice',
      libraryScopeKey: 'library:local',
      firestore: database(),
      sdk: { doc, runTransaction, serverTimestamp },
    }),
    applyProgressEventTransaction({
      event: secondEvent,
      uid: 'alice',
      libraryScopeKey: 'library:local',
      firestore: database(),
      sdk: { doc, runTransaction, serverTimestamp },
    }),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['apply', 'conflict']);
  const winningEvent = results[0].status === 'apply' ? firstEvent : secondEvent;
  const replay = await applyProgressEventTransaction({
    event: winningEvent,
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(replay.status, 'already_applied');
  assert.equal(replay.head.revision, 1);

  const reset = await applyProgressEventTransaction({
    event: progressEvent(fixtureEvent('reset-event'), 0, 1, 'progress.reset'),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(reset.status, 'apply');
  assert.equal(reset.head.revision, 2);
  assert.equal(reset.head.operation, 'reset');

  const stale = await applyProgressEventTransaction({
    event: progressEvent(fixtureEvent('stale-set'), 90, 1),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 2);
});

test('runs bookmark transaction receipt replay, tombstone, and stale edit conflict', async () => {
  const upsertEvent = bookmarkEvent(fixtureEvent('bookmark-upsert'));
  const upsert = await applyBookmarkEventTransaction({
    event: upsertEvent,
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(upsert.status, 'apply');

  const replay = await applyBookmarkEventTransaction({
    event: upsertEvent,
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(replay.status, 'already_applied');

  const deletion = await applyBookmarkEventTransaction({
    event: bookmarkEvent(fixtureEvent('bookmark-delete'), 1, 'bookmark.delete'),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.operation, 'delete');
  assert.equal(deletion.head.revision, 2);

  const stale = await applyBookmarkEventTransaction({
    event: bookmarkEvent(fixtureEvent('bookmark-stale'), 1),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 2);
});

test('allows atomic annotation revisions, receipt replay, and tombstone delete', async () => {
  const firstEvent = annotationEvent(fixtureEvent('annotation-upsert'));
  const first = await applyAnnotationEventTransaction({
    event: firstEvent,
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(first.status, 'apply');
  const replay = await applyAnnotationEventTransaction({
    event: firstEvent,
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(replay.status, 'already_applied');

  const deletion = await applyAnnotationEventTransaction({
    event: annotationEvent(fixtureEvent('annotation-delete'), 1, 'annotation.delete'),
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.operation, 'delete');
  assert.equal(deletion.head.revision, 2);
  await assertFails(deleteDoc(doc(database(), annotationPath())));
  await assertFails(setDoc(
    doc(database(), annotationReceiptPath(fixtureEvent('annotation-upsert'))),
    validAnnotationReceipt(fixtureEvent('annotation-upsert'), 1),
  ));
});

test('serializes concurrent different ids and rejects a duplicate remote range', async () => {
  const db = database();
  const rangeCfi = 'epubcfi(/6/4!/4/2,/1:0,/1:4)';
  const eventFor = (annotationId) => ({
    eventId: fixtureEvent(`event-${annotationId}`),
    target: { kind: 'annotation', bookId: 'book-1', annotationId },
    targetKey: `annotation:book-1:${annotationId}`,
    operation: 'annotation.upsert',
    payload: {
      ...validAnnotationPayload(),
      id: annotationId,
      rangeCfi,
      quote: `문장 ${annotationId}`,
    },
    deviceId: 'device-1',
    sessionId: `session-${annotationId}`,
    baseRevision: 0,
    bookGeneration: 0,
    occurredAtClient: 1,
  });
  const results = await Promise.all(['a', 'b'].map((annotationId) => (
    applyAnnotationEventTransaction({
      event: eventFor(annotationId),
      uid: 'alice',
      firestore: db,
      sdk: { doc, runTransaction, serverTimestamp },
    })
  )));
  assert.deepEqual(results.map(({ status }) => status).sort(), ['apply', 'conflict']);
  assert.equal(
    results.find(({ status }) => status === 'conflict').conflictReason,
    'annotation-duplicate-range',
  );
  const aggregate = await getDoc(doc(db, annotationAggregatePath()));
  assert.equal(aggregate.data().totalCount, 1);
});

test('applies a fenced book-deletion tombstone while protecting a concurrent same-ID edit', async () => {
  const db = database();
  const write = (event) => applyAnnotationEventTransaction({
    event,
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  const original = await write(annotationEvent(fixtureEvent('fenced-delete-upsert')));
  const historical = annotationEvent(fixtureEvent('fenced-historical-upsert'));
  historical.target.annotationId = 'historical';
  historical.targetKey = 'annotation:book-1:historical';
  historical.payload = { ...historical.payload, id: 'historical', rangeCfi: 'epubcfi(/6/4!/4/2,/1:4,/1:8)' };
  await write(historical);
  const marker = await write({
    ...annotationEvent(fixtureEvent('fenced-delete-marker'), 0, 'annotation.delete'),
    target: { kind: 'annotation', bookId: 'book-1', annotationId: 'book_delete_marker_v1' },
    targetKey: 'annotation:book-1:book_delete_marker_v1',
  });
  const edited = await write({
    ...annotationEvent(fixtureEvent('fenced-delete-edit'), original.head.revision), bookGeneration: marker.receipt.revision,
  });
  assert.equal(edited.status, 'apply');

  const unknownMarker = await write({
    ...annotationEvent(fixtureEvent('unknown-marker-base'), 0, 'annotation.delete'),
    target: { kind: 'annotation', bookId: 'book-1', annotationId: 'book_delete_marker_v1' },
    targetKey: 'annotation:book-1:book_delete_marker_v1',
  });
  assert.equal(unknownMarker.status, 'superseded');
  assert.equal(unknownMarker.remoteMarker.revision, marker.receipt.revision);
  assert.equal(unknownMarker.remoteMarker.acceptedEventId, marker.receipt.eventId);

  const boundary = marker.receipt.revision;
  const skipped = await write({
    ...annotationEvent(fixtureEvent('fenced-delete-skip'), original.head.revision, 'annotation.delete'),
    deleteBeforeBookGeneration: boundary,
  });
  assert.equal(skipped.status, 'superseded');
  assert.equal((await getDoc(doc(db, annotationPath()))).data().acceptedEventId, edited.receipt.eventId);

  const deletion = await write({
    ...annotationEvent(fixtureEvent('fenced-delete-tombstone'), 1, 'annotation.delete'),
    target: historical.target,
    targetKey: historical.targetKey,
    deleteBeforeBookGeneration: boundary,
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.revision, 2);
  assert.equal(deletion.head.operation, 'delete');
  assert.equal((await getDoc(doc(db, annotationAggregatePath()))).data().totalCount, 1);
});

test('book deletion marker blocks stale offline upserts but allows a new highlight', async () => {
  const db = database();
  const markerEvent = {
    eventId: fixtureEvent('book-delete-marker'),
    target: {
      kind: 'annotation',
      bookId: 'book-1',
      annotationId: 'book_delete_marker_v1',
    },
    targetKey: 'annotation:book-1:book_delete_marker_v1',
    operation: 'annotation.delete',
    payload: null,
    deviceId: 'device-1',
    sessionId: 'deleting-session',
    baseRevision: 0,
    occurredAtClient: 10,
  };
  await applyAnnotationEventTransaction({
    event: markerEvent,
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  const eventFor = (id, rangeCfi, eventId, occurredAtClient, bookGeneration) => ({
    eventId,
    target: { kind: 'annotation', bookId: 'book-1', annotationId: id },
    targetKey: `annotation:book-1:${id}`,
    operation: 'annotation.upsert',
    payload: {
      ...validAnnotationPayload(),
      id,
      rangeCfi,
      quote: `문장 ${id}`,
    },
    deviceId: 'device-1',
    sessionId: `session-${id}`,
    baseRevision: 0,
    bookGeneration,
    occurredAtClient,
  });
  const stale = eventFor(
    'stale-offline',
    'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    fixtureEvent('stale-offline-event'),
    9_999_999,
    0,
  );
  const staleDecision = await applyAnnotationEventTransaction({
    event: stale,
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(staleDecision.status, 'conflict');
  assert.equal(staleDecision.conflictReason, 'annotation-book-generation');

  const markerAggregate = (await getDoc(doc(db, annotationAggregatePath()))).data();
  const malicious = writeBatch(db);
  malicious.set(doc(db, annotationPath('malicious-stale')), {
    ...validAnnotationHead(fixtureEvent('malicious-stale-event')),
    annotationId: 'malicious-stale',
    annotation: {
      ...validAnnotationPayload(),
      id: 'malicious-stale',
      rangeCfi: 'epubcfi(/6/4!/4/2,/1:10,/1:14)',
      quote: 'malicious stale',
    },
    occurredAtClient: 9_999_999,
    bookGeneration: 0,
  });
  malicious.set(doc(db, annotationReceiptPath(fixtureEvent('malicious-stale-event'))), {
    ...validAnnotationReceipt(fixtureEvent('malicious-stale-event')),
    annotationId: 'malicious-stale',
    targetKey: 'annotation:book-1:malicious-stale',
  });
  malicious.set(doc(db, annotationAggregatePath()), {
    ...markerAggregate,
    revision: markerAggregate.revision + 1,
    totalCount: 1,
    colorCounts: { yellow: 1, green: 0, blue: 0, pink: 0, purple: 0 },
    entries: {
      'malicious-stale': {
        rangeCfi: 'epubcfi(/6/4!/4/2,/1:10,/1:14)',
        colorId: 'yellow',
      },
    },
    rangeCfis: ['epubcfi(/6/4!/4/2,/1:10,/1:14)'],
    acceptedEventId: fixtureEvent('malicious-stale-event'),
    acceptedAnnotationId: 'malicious-stale',
    acceptedOperation: 'upsert',
    updatedAtServer: serverTimestamp(),
  });
  await assertFails(malicious.commit());

  const fresh = eventFor(
    'fresh-highlight',
    'epubcfi(/6/4!/4/2,/1:5,/1:9)',
    fixtureEvent('fresh-highlight-event'),
    1,
    1,
  );
  const applied = await applyAnnotationEventTransaction({
    event: fresh,
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(applied.status, 'apply');
});

test('rejects invalid annotation identity, payload fields, revision jumps, and orphan receipts', async () => {
  const db = database();
  await assertSucceeds(writeAnnotationEvent(db));

  const invalid = writeBatch(db);
  invalid.set(doc(db, annotationPath()), {
    ...validAnnotationHead(fixtureEvent('annotation-event-2'), 2),
    annotation: { ...validAnnotationPayload(), anchorState: 'unresolved' },
  });
  invalid.set(
    doc(db, annotationReceiptPath(fixtureEvent('annotation-event-2'))),
    validAnnotationReceipt(fixtureEvent('annotation-event-2'), 2),
  );
  await assertFails(invalid.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, annotationPath()), validAnnotationHead(fixtureEvent('annotation-event-3'), 3));
  jump.set(
    doc(db, annotationReceiptPath(fixtureEvent('annotation-event-3'))),
    validAnnotationReceipt(fixtureEvent('annotation-event-3'), 3),
  );
  await assertFails(jump.commit());
  await assertFails(setDoc(
    doc(db, annotationReceiptPath(fixtureEvent('orphan-annotation'))),
    validAnnotationReceipt(fixtureEvent('orphan-annotation'), 2),
  ));
  await assertFails(getDoc(doc(database('mallory'), annotationPath())));
});

test('rejects malformed CFI, whitespace quotes, and unsafe annotation client integers', async () => {
  const invalidPayloads = [
    {
      ...validAnnotationPayload(),
      rangeCfi: 'not-a-cfi',
    },
    { ...validAnnotationPayload(), quote: '   \n' },
    { ...validAnnotationPayload(), updatedAtClient: 9007199254740992 },
  ];
  for (const [index, payload] of invalidPayloads.entries()) {
    const db = database();
    const eventId = fixtureEvent(`invalid-annotation-${index}`);
    const batch = writeBatch(db);
    batch.set(doc(db, annotationPath()), {
      ...validAnnotationHead(eventId),
      annotation: payload,
    });
    batch.set(doc(db, annotationAggregatePath()), {
      ...validAnnotationAggregate(eventId),
      entries: {
        'annotation-1': { rangeCfi: payload.rangeCfi, colorId: payload.colorId },
      },
      rangeCfis: [payload.rangeCfi],
    });
    batch.set(
      doc(db, annotationReceiptPath(eventId)),
      validAnnotationReceipt(eventId),
    );
    await assertFails(batch.commit());
  }
});

test('allows a valid multiline annotation quote', async () => {
  const db = database();
  const eventId = fixtureEvent('multiline-annotation');
  const payload = { ...validAnnotationPayload(), quote: 'first line\nsecond line' };
  const batch = writeBatch(db);
  batch.set(doc(db, annotationPath()), {
    ...validAnnotationHead(eventId),
    annotation: payload,
  });
  batch.set(doc(db, annotationAggregatePath()), {
    ...validAnnotationAggregate(eventId),
    entries: {
      'annotation-1': { rangeCfi: payload.rangeCfi, colorId: payload.colorId },
    },
    rangeCfis: [payload.rangeCfi],
  });
  batch.set(
    doc(db, annotationReceiptPath(eventId)),
    validAnnotationReceipt(eventId),
  );
  await assertSucceeds(batch.commit());
});

test('rejects an aggregate-only revision even when it reuses the old accepted head', async () => {
  const db = database();
  await assertSucceeds(writeAnnotationEvent(db));
  await assertFails(setDoc(
    doc(db, annotationAggregatePath()),
    validAnnotationAggregate(fixtureEvent('annotation-event-1'), 2),
  ));
});

test('rejects an initial aggregate whose color count disagrees with its annotation', async () => {
  const db = database();
  const eventId = fixtureEvent('wrong-initial-color-count');
  const batch = writeBatch(db);
  batch.set(doc(db, annotationPath()), validAnnotationHead(eventId));
  batch.set(doc(db, annotationAggregatePath()), {
    ...validAnnotationAggregate(eventId),
    colorCounts: { yellow: 0, green: 1, blue: 0, pink: 0, purple: 0 },
  });
  batch.set(
    doc(db, annotationReceiptPath(eventId)),
    validAnnotationReceipt(eventId),
  );
  await assertFails(batch.commit());
});

test('rejects an atomic event that mutates an unrelated aggregate entry', async () => {
  const db = database();
  const eventFor = (annotationId, offset) => ({
    eventId: fixtureEvent(`seed-${annotationId}`),
    target: { kind: 'annotation', bookId: 'book-1', annotationId },
    targetKey: `annotation:book-1:${annotationId}`,
    operation: 'annotation.upsert',
    payload: {
      ...validAnnotationPayload(),
      id: annotationId,
      rangeCfi: `epubcfi(/6/4!/4/2,/1:${offset},/1:${offset + 1})`,
      quote: `문장 ${annotationId}`,
    },
    deviceId: 'device-1',
    sessionId: 'session-1',
    baseRevision: 0,
    occurredAtClient: offset + 1,
  });
  await applyAnnotationEventTransaction({
    event: eventFor('a', 0),
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  await applyAnnotationEventTransaction({
    event: eventFor('b', 2),
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  const aggregate = (await getDoc(doc(db, annotationAggregatePath()))).data();
  const headARef = doc(db, annotationPath('a'));
  const headA = (await getDoc(headARef)).data();
  const eventId = fixtureEvent('malicious-erase-b');
  const batch = writeBatch(db);
  batch.set(headARef, {
    ...headA,
    revision: 2,
    acceptedEventId: eventId,
    annotation: { ...headA.annotation, note: 'a만 수정' },
    occurredAtClient: 10,
    updatedAtServer: serverTimestamp(),
  });
  batch.set(doc(db, annotationReceiptPath(eventId)), {
    schemaVersion: 1,
    eventId,
    targetKind: 'annotation',
    bookId: 'book-1',
    annotationId: 'a',
    targetKey: 'annotation:book-1:a',
    revision: 2,
    createdAtServer: serverTimestamp(),
  });
  batch.set(doc(db, annotationAggregatePath()), {
    ...aggregate,
    revision: aggregate.revision + 1,
    totalCount: 1,
    colorCounts: { yellow: 1, green: 0, blue: 0, pink: 0, purple: 0 },
    entries: { a: aggregate.entries.a },
    rangeCfis: [aggregate.entries.a.rangeCfi],
    acceptedEventId: eventId,
    acceptedAnnotationId: 'a',
    acceptedOperation: 'upsert',
    updatedAtServer: serverTimestamp(),
  });
  await assertFails(batch.commit());
});

test('rejects an aggregate update with an incorrect accepted-color delta', async () => {
  const db = database();
  await assertSucceeds(writeAnnotationEvent(db));
  const aggregate = (await getDoc(doc(db, annotationAggregatePath()))).data();
  const headRef = doc(db, annotationPath());
  const head = (await getDoc(headRef)).data();
  const eventId = fixtureEvent('wrong-color-delta');
  const batch = writeBatch(db);
  batch.set(headRef, {
    ...head,
    revision: 2,
    acceptedEventId: eventId,
    annotation: { ...head.annotation, colorId: 'green' },
    occurredAtClient: 10,
    updatedAtServer: serverTimestamp(),
  });
  batch.set(doc(db, annotationReceiptPath(eventId)), {
    ...validAnnotationReceipt(eventId, 2),
  });
  batch.set(doc(db, annotationAggregatePath()), {
    ...aggregate,
    revision: 2,
    colorCounts: { yellow: 0, green: 0, blue: 1, pink: 0, purple: 0 },
    entries: {
      'annotation-1': {
        ...aggregate.entries['annotation-1'],
        colorId: 'green',
      },
    },
    acceptedEventId: eventId,
    acceptedAnnotationId: 'annotation-1',
    acceptedOperation: 'upsert',
    updatedAtServer: serverTimestamp(),
  });
  await assertFails(batch.commit());
});

test('allows one atomic palette revision chain with replay and stale conflict', async () => {
  const firstEvent = paletteEvent(fixtureEvent('palette-upsert'));
  const first = await applyAnnotationPaletteEventTransaction({
    event: firstEvent,
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(first.status, 'apply');
  const replay = await applyAnnotationPaletteEventTransaction({
    event: firstEvent,
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(replay.status, 'already_applied');
  const stale = await applyAnnotationPaletteEventTransaction({
    event: paletteEvent(fixtureEvent('palette-stale')),
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 1);
});

test('rejects malformed palettes, revision jumps, orphan receipts, and other owners', async () => {
  const db = database();
  await assertSucceeds(writePaletteEvent(db));

  const invalid = writeBatch(db);
  const reversed = [...DEFAULT_ANNOTATION_PALETTE].reverse();
  invalid.set(doc(db, palettePath()), {
    ...validPaletteHead(fixtureEvent('palette-event-2'), 2),
    palette: { items: reversed },
  });
  invalid.set(
    doc(db, paletteReceiptPath(fixtureEvent('palette-event-2'))),
    validPaletteReceipt(fixtureEvent('palette-event-2'), 2),
  );
  await assertFails(invalid.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, palettePath()), validPaletteHead(fixtureEvent('palette-event-3'), 3));
  jump.set(
    doc(db, paletteReceiptPath(fixtureEvent('palette-event-3'))),
    validPaletteReceipt(fixtureEvent('palette-event-3'), 3),
  );
  await assertFails(jump.commit());
  await assertFails(setDoc(
    doc(db, paletteReceiptPath(fixtureEvent('orphan-palette'))),
    validPaletteReceipt(fixtureEvent('orphan-palette'), 2),
  ));
  await assertFails(getDoc(doc(database('mallory'), palettePath())));
});

test('rejects retired v1 progress documents', async () => {
  const path = `artifacts/${appId}/users/alice/readingHistory/book-1`;
  const own = database();
  await assertFails(setDoc(doc(own, path), {
    bookId: 'book-1',
    cfi: '',
    progressPercent: 0,
    lastRead: serverTimestamp(),
    bookmarks: [],
    deviceId: 'old-device',
  }));
});

test('rejects Drive-scoped progress paths even for the owning Firebase uid', async () => {
  const drivePath = `artifacts/${appId}/users/alice/libraries/drive-account/readingHistoryV2/book-1`;
  await assertFails(getDoc(doc(database(), drivePath)));
});

test('creates immutable reading statistic sessions and replays the same payload', async () => {
  const db = database();
  const record = validReadingSession();
  const sdk = { doc, runTransaction, serverTimestamp };
  assert.deepEqual(await uploadReadingSessionV1(db, 'alice', record, sdk), { status: 'created' });
  assert.deepEqual(await uploadReadingSessionV1(db, 'alice', record, sdk), { status: 'replayed' });
  const snapshot = await assertSucceeds(getDoc(doc(db, readingStatisticsPath())));
  assert.equal(snapshot.data().bookId, 'book-1');
  assert.equal(snapshot.data().durationMs, 60_000);
  assert.deepEqual(
    await uploadReadingSessionV1(db, 'alice', { ...record, bookTitle: 'Collision' }, sdk),
    { status: 'conflict', remote: record },
  );
  await assertFails(setDoc(doc(db, readingStatisticsPath()), {
    ...record,
    bookTitle: 'Updated',
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, readingStatisticsPath())));
});

test('allows an explicit reading-round completion marker at any progress', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath('completion-marker')), {
    ...validReadingSession('completion-marker'),
    endProgressPercent: 20,
    completed: true,
    completionConfirmedAtClient: 62_000,
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, readingStatisticsPath('completion-unconfirmed')), {
    ...validReadingSession('completion-unconfirmed'),
    endProgressPercent: 99,
    completed: false,
    completionConfirmedAtClient: 62_000,
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, readingStatisticsPath('completion-before-session-end')), {
    ...validReadingSession('completion-before-session-end'),
    endProgressPercent: 99,
    completed: true,
    completionConfirmedAtClient: 60_000,
    uploadedAtServer: serverTimestamp(),
  }));
});

test('accepts a logical completion round only on a valid confirmed marker', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath('logical-completion')), {
    ...validReadingSession('logical-completion'),
    completed: true,
    completionConfirmedAtClient: 62_000,
    completionRoundNumber: 1,
    uploadedAtServer: serverTimestamp(),
  }));
  for (const [index, patch] of [
    { completionRoundNumber: 0 },
    { completionRoundNumber: 1.5 },
    { completionRoundNumber: 9007199254740992 },
    { completed: false },
  ].entries()) {
    const id = `invalid-logical-completion-${index}`;
    await assertFails(setDoc(doc(db, readingStatisticsPath(id)), {
      ...validReadingSession(id), completed: true, completionConfirmedAtClient: 62_000,
      completionRoundNumber: 1, ...patch, uploadedAtServer: serverTimestamp(),
    }));
  }
  await assertFails(setDoc(doc(db, readingStatisticsPath('unconfirmed-logical-round')), {
    ...validReadingSession('unconfirmed-logical-round'),
    completionRoundNumber: 1,
    uploadedAtServer: serverTimestamp(),
  }));
});

test('accepts bounded TTS active intervals and rejects a mismatched wall timeline', async () => {
  const db = database();
  const startedAtClient = 1_000;
  const endedAtClient = 601_000;
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath('tts-intervals')), {
    ...validReadingSession('tts-intervals'),
    mode: 'tts',
    startedAtClient,
    endedAtClient,
    durationMs: 300_000,
    localDate: getReadingSessionLocalDate(startedAtClient, 0),
    activeIntervals: [
      { startedAtClient, endedAtClient: 151_000 },
      { startedAtClient: 451_000, endedAtClient },
    ],
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, readingStatisticsPath('tts-bad-intervals')), {
    ...validReadingSession('tts-bad-intervals'),
    mode: 'tts',
    startedAtClient,
    endedAtClient,
    durationMs: 300_000,
    localDate: getReadingSessionLocalDate(startedAtClient, 0),
    activeIntervals: [
      { startedAtClient: 2_000, endedAtClient: 151_000 },
      { startedAtClient: 451_000, endedAtClient },
    ],
    uploadedAtServer: serverTimestamp(),
  }));
});

test('accepts a bounded full clock sample and rejects partial clock metadata', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath('clocked')), {
    ...validReadingSession('clocked'),
    clockOffsetMs: -600_000,
    clockUncertaintyMs: 250,
    clockMeasuredAtClient: 1_000,
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, readingStatisticsPath('partial-clock')), {
    ...validReadingSession('partial-clock'),
    clockOffsetMs: 0,
    uploadedAtServer: serverTimestamp(),
  }));
});

test('accepts a bounded legacy local date that hydration normalizes from timestamps', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath('legacy-local-date')), {
    ...validReadingSession('legacy-local-date'),
    localDate: '2026-12-31',
    uploadedAtServer: serverTimestamp(),
  }));
});

test('rejects malformed or cross-owner reading statistic sessions', async () => {
  const db = database();
  const malformed = validReadingSession('malformed');
  await assertFails(setDoc(doc(db, readingStatisticsPath('malformed')), {
    ...malformed,
    durationMs: 59_999,
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(db, readingStatisticsPath('extra')), {
    ...validReadingSession('extra'),
    unexpected: true,
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(getDoc(doc(database('mallory'), readingStatisticsPath())));
  const drivePath = `artifacts/${appId}/users/alice/libraries/drive-account/readingStatsV1/drive-session`;
  await assertFails(setDoc(doc(db, drivePath), {
    ...validReadingSession('drive-session'),
    uploadedAtServer: serverTimestamp(),
  }));
});

test('weekly statistics audit allows a device to fetch only new uploads and rejects missing history', async () => {
  const stamp = new Timestamp(60, 931_000);
  const newer = new Timestamp(60, 932_000);
  const sdk = {
    collection, doc, documentId, endAt, getCountFromServer, getDocsFromServer, limit, limitToLast,
    orderBy, query, startAfter, startAt, Timestamp,
  };
  const seed = (id, uploadedAtServer) => environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), readingStatisticsPath(id)), {
      ...validReadingSession(id), uploadedAtServer,
    });
  });
  await seed('a-earlier', stamp);
  await seed('b-last-received', stamp);
  const cursor = {
    uploadedAtServerSeconds: stamp.seconds,
    uploadedAtServerNanoseconds: stamp.nanoseconds,
    documentId: 'b-last-received',
  };
  const expected = { remoteCount: 2, cursor };
  const db = database();
  const verify = () => assertSucceeds(verifyRemoteReadingStatisticsAuditV1(db, 'alice', expected, {}, sdk));
  assert.equal(await verify(), true);

  await seed('c-same-upload-time', stamp);
  await seed('d-newer-upload-time', newer);
  assert.equal(await verify(), true, 'uploads after the saved cursor do not invalidate already received history');
  const page = await assertSucceeds(getRemoteReadingSessionsPageV1(db, 'alice', cursor, 500, sdk));
  assert.deepEqual(page.sessions.map(({ sessionId }) => sessionId), ['c-same-upload-time', 'd-newer-upload-time']);
  await assertFails(verifyRemoteReadingStatisticsAuditV1(database('mallory'), 'alice', expected, {}, sdk));

  await environment.withSecurityRulesDisabled(async (context) => {
    await deleteDoc(doc(context.firestore(), readingStatisticsPath('a-earlier')));
  });
  assert.equal(await verify(), false, 'new uploads cannot hide a missing earlier document');
  await environment.withSecurityRulesDisabled(async (context) => {
    await deleteDoc(doc(context.firestore(), readingStatisticsPath('b-last-received')));
  });
  await seed('a-earlier', stamp);
  await seed('a-replacement', stamp);
  assert.equal(await verify(), false, 'matching counts cannot hide a missing cursor document');
});

test('a recently completed legacy statistics checkpoint reads only its marker and the next upload', async (t) => {
  await import('fake-indexeddb/auto');
  t.after(closeLocalDB);
  const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('alice'), 'library:local');
  const historical = ['legacy-history', 'legacy-marker'].map(validReadingSession);
  const stamp = new Timestamp(60, 931_000);
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const batch = writeBatch(db);
    for (const session of historical) {
      batch.set(doc(db, readingStatisticsPath(session.sessionId)), { ...session, uploadedAtServer: stamp });
    }
    await batch.commit();
  });

  const now = Date.now();
  const cursor = { documentId: 'legacy-marker', uploadedAtServerSeconds: stamp.seconds, uploadedAtServerNanoseconds: stamp.nanoseconds };
  await hydrateRemoteReadingSessionsPageV12(ownerKey, historical, null, cursor, true, false, [], now);
  const local = await initDB();
  const legacy = await local.get(V12_READING_STATISTICS_SYNC_STORE, ownerKey);
  delete legacy.cursorVersion;
  await local.put(V12_READING_STATISTICS_SYNC_STORE, legacy);

  const db = database();
  const nextId = 'new-after-adoption';
  await assertSucceeds(setDoc(doc(db, readingStatisticsPath(nextId)), {
    ...validReadingSession(nextId), uploadedAtServer: serverTimestamp(),
  }));
  const returned = [];
  const sdk = {
    collection, doc, documentId, endAt, limit, orderBy, query, startAfter, startAt, Timestamp,
    getDocFromServer: async (reference) => {
      const snapshot = await getDocFromServer(reference);
      returned.push(['marker', reference.path, snapshot.id]);
      return snapshot;
    },
    getDocsFromServer: async (target) => {
      const snapshot = await getDocsFromServer(target);
      returned.push(['incremental', ...snapshot.docs.map(({ id }) => id)]);
      return snapshot;
    },
  };
  const lease = await acquireReadingStatisticsSyncLeaseV13(ownerKey, 'legacy-adoption', now);
  const { legacyCursor } = await getReadingStatisticsHydrationPlanV12(ownerKey, now);
  assert.equal(await verifyLegacyReadingStatisticsCursorV1(db, 'alice', legacyCursor, {}, sdk), true);
  assert.equal(await adoptLegacyReadingStatisticsCursorV12(ownerKey, legacyCursor, lease, () => now), true);
  const plan = await getReadingStatisticsHydrationPlanV12(ownerKey, now);
  assert.equal(plan.state.lastFullAuditAt, now);
  const page = await getRemoteReadingSessionsPageV1(db, 'alice', plan.state.cursor, 500, sdk, {}, {
    timestampRangeOnly: !plan.fullAuditInProgress,
  });
  assert.equal(page.fullHydrationCompleted, true);
  assert.deepEqual(page.sessions.map(({ sessionId }) => sessionId), [nextId]);
  assert.deepEqual(returned, [
    ['marker', readingStatisticsPath(cursor.documentId), cursor.documentId],
    ['incremental', nextId],
  ]);
});

test('the publication audit compares the old checkpoint and receives only later uploads', async (t) => {
  await import('fake-indexeddb/auto');
  t.after(closeLocalDB);
  const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('published-fixture'), 'library:local');
  const history = ['archived-a', 'archived-z'].map(validReadingSession);
  const stamp = new Timestamp(60, 931_000);
  const future = new Timestamp(60, 932_000);
  const next = validReadingSession('open-period');
  await environment.withSecurityRulesDisabled(async (context) => {
    const batch = writeBatch(context.firestore());
    for (const session of [...history, next]) batch.set(doc(context.firestore(), readingStatisticsPath(session.sessionId, 'published-fixture')),
      { ...session, uploadedAtServer: session === next ? future : stamp });
    await batch.commit();
  });
  const fullAt = 200_000;
  const now = fullAt + 28 * 86_400_000;
  const exact = { documentId: 'archived-z', uploadedAtServerSeconds: stamp.seconds, uploadedAtServerNanoseconds: stamp.nanoseconds };
  await hydrateRemoteReadingSessionsPageV12(ownerKey, history, null, exact, true, false, [], fullAt);
  const lease = await acquireReadingStatisticsSyncLeaseV13(ownerKey, 'published-plan', now);
  const { candidate } = await getReadingStatisticsHydrationPlanV12(ownerKey, now, true);
  const db = database('published-fixture');
  const reads = [];
  const sdk = { collection, doc, documentId, endAt, getCountFromServer, getDocFromServer, limit, limitToLast,
    orderBy, query, startAfter, startAt, Timestamp,
    getDocsFromServer: async (query) => {
      const snapshot = await getDocsFromServer(query);
      reads.push(snapshot.docs.map(({ id }) => id));
      return snapshot;
    },
  };
  assert.equal(await verifyRemoteReadingStatisticsAuditV1(db, 'published-fixture', candidate, {}, sdk), true);
  assert.equal(await recordReadingStatisticsVerifiedAuditV12(ownerKey, candidate, lease, () => now), true);
  const page = await getRemoteReadingSessionsPageV1(db, 'published-fixture', candidate.cursor, 500, sdk, {}, { timestampRangeOnly: true });
  assert.deepEqual(page.sessions.map(({ sessionId }) => sessionId), [next.sessionId]);
  assert.deepEqual(reads, [[exact.documentId], [next.sessionId]]);
});

test('statistics hydration quarantines a mixed-type tail and later resumes within the timestamp range', async () => {
  const sdk = { collection, doc, documentId, endAt, getDocFromServer, getDocsFromServer, limit, orderBy, query, startAfter, startAt, Timestamp };
  const stamp = new Timestamp(60, 931_000);
  const seed = (entries) => environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const batch = writeBatch(db);
    for (const [id, uploadedAtServer] of entries) {
      batch.set(doc(db, readingStatisticsPath(id)), { ...validReadingSession(id), uploadedAtServer });
    }
    await batch.commit();
  });
  await seed([
    ['a-valid', stamp],
    ['b-valid', stamp],
    ['c-map', { seconds: 900_000, nanoseconds: 10 }],
    ['d-map', { seconds: 900_000, nanoseconds: 10 }],
    ['e-map', { seconds: 900_000, nanoseconds: 10 }],
  ]);
  const db = database();
  const first = await getRemoteReadingSessionsPageV1(db, 'alice', null, 2, sdk);
  assert.deepEqual(first.sessions.map(({ sessionId }) => sessionId), ['a-valid', 'b-valid']);
  assert.equal(first.fullHydrationCompleted, false);

  const storedCursor = structuredClone(first.nextCursor);
  assert.equal(await verifyLegacyReadingStatisticsCursorV1(db, 'alice', storedCursor, {}, sdk), true);
  assert.equal(await verifyLegacyReadingStatisticsCursorV1(db, 'alice', {
    documentId: 'c-map', uploadedAtServerSeconds: 900_000, uploadedAtServerNanoseconds: 10,
  }, {}, sdk), false);
  const tail = await getRemoteReadingSessionsPageV1(db, 'alice', storedCursor, 2, sdk);
  assert.equal(tail.remoteReadCount, 2);
  assert.deepEqual(tail.sessions, []);
  assert.deepEqual(tail.quarantinedDocuments.map(({ documentId: id }) => id), ['c-map', 'd-map', 'e-map']);
  assert.deepEqual(tail.nextCursor, storedCursor);
  assert.equal(tail.fullHydrationCompleted, true);

  await seed([['f-same-time', stamp], ['g-new-time', new Timestamp(60, 932_000)]]);
  const next = await getRemoteReadingSessionsPageV1(db, 'alice', storedCursor, 2, sdk, {}, { timestampRangeOnly: true });
  assert.deepEqual(next.sessions.map(({ sessionId }) => sessionId), ['f-same-time', 'g-new-time']);
  assert.deepEqual(next.quarantinedDocuments, []);
  const done = await getRemoteReadingSessionsPageV1(db, 'alice', next.nextCursor, 2, sdk, {}, { timestampRangeOnly: true });
  assert.equal(done.remoteReadCount, 1);
  assert.equal(done.fullHydrationCompleted, true);
  assert.deepEqual(done.quarantinedDocuments, []);
});

const leaseUuid = '2af12345-1234-4123-8123-123456789abc';
const eventUuid = '3af12345-1234-4123-8123-123456789abc';
const leasePath = (uid = 'alice') => `artifacts/${appId}/users/${uid}/libraries/local/writeLeases/${leaseUuid}`;
const policyPath = `artifacts/${appId}/users/alice/libraries/local/syncPolicyV1/writeLease`;
const leasedId = (millis) => `wl1_${leaseUuid}_${millis}_${eventUuid}`;
const seedLease = async (millis, deviceId = 'device-1', nanos = 0) => environment.withSecurityRulesDisabled(async (context) => {
  await setDoc(doc(context.firestore(), leasePath()), {
    schemaVersion: 1, deviceId,
    issuedAtServer: new Timestamp(Math.floor(millis / 1000), (millis % 1000) * 1e6 + nanos),
  });
});
const seedPolicy = async (requireLeases) => environment.withSecurityRulesDisabled(async (context) => {
  await setDoc(doc(context.firestore(), policyPath), { schemaVersion: 1, requireLeases, legacyBlockedAtServer: null });
});
const leaseWriters = [writeProgressEvent, writeBookmarkEvent, writeAnnotationEvent, writePaletteEvent];

test('lease document is owner get and create only; policy is owner get and admin write only', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, leasePath()), { schemaVersion: 1, deviceId: 'device-1', issuedAtServer: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(db, leasePath())));
  await assertFails(getDoc(doc(database('bob'), leasePath())));
  await assertFails(getDocs(collection(db, leasePath().replace(/\/[^/]+$/, ''))));
  await assertFails(setDoc(doc(db, leasePath()), { schemaVersion: 1, deviceId: 'device-1', issuedAtServer: serverTimestamp() }));
  await assertFails(deleteDoc(doc(db, leasePath())));
  await assertFails(setDoc(doc(database('bob'), leasePath()), { schemaVersion: 1, deviceId: 'device-1', issuedAtServer: serverTimestamp() }));
  await assertFails(setDoc(doc(db, policyPath), { schemaVersion: 1, requireLeases: false, legacyBlockedAtServer: null }));
  await seedPolicy(false);
  await assertSucceeds(getDoc(doc(db, policyPath)));
  await assertFails(getDoc(doc(database('bob'), policyPath)));
  await assertFails(getDocs(collection(db, policyPath.replace(/\/[^/]+$/, ''))));
});

test('globally requires leases for all four atomic paths regardless of policy', async () => {
  for (const write of leaseWriters) {
    for (const policy of [null, false, true]) {
      await environment.clearFirestore();
      const issued = Date.now() - 90 * 864e5 + 60_000;
      await seedLease(issued, 'device-1', 456789);
      if (policy !== null) await seedPolicy(policy);
      await assertFails(write(database(), 'legacy-event'));
      await assertFails(write(database(), eventUuid));
      await assertSucceeds(write(database(), leasedId(issued)));
    }
  }
});

test('an upgraded client reads a legacy position and continues its revision with a leased write', async () => {
  const legacyReceiptPath = `${progressPath()}/eventReceipts/${eventUuid}`;
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const batch = writeBatch(db);
    batch.set(doc(db, progressPath()), validHead(eventUuid));
    batch.set(doc(db, legacyReceiptPath), validReceipt(eventUuid));
    await batch.commit();
  });
  const db = database();
  const previous = await assertSucceeds(getDoc(doc(db, progressPath())));
  assert.equal(previous.data().acceptedEventId, eventUuid);
  assert.equal((await assertSucceeds(getDoc(doc(db, legacyReceiptPath)))).data().eventId, eventUuid);
  const eventId = fixtureEvent('after-upgrade');
  await assertSucceeds(writeProgressEvent(db, eventId, 2));
  const saved = await assertSucceeds(getDoc(doc(db, progressPath())));
  assert.equal(saved.data().revision, 2);
  assert.equal(saved.data().acceptedEventId, eventId);
});

test('leased event fails closed for forged timestamp, device, malformed id, expiry, and reused lease id', async () => {
  for (const write of leaseWriters) {
    await environment.clearFirestore();
    const issued = Date.now() - 10000;
    await seedLease(issued);
    await assertFails(write(database(), leasedId(issued + 1)));
    await seedLease(issued, 'other-device');
    await assertFails(write(database(), leasedId(issued)));
    await assertFails(write(database(), 'wl1_invalid'));
    await assertFails(write(database(), 'unleased_event'));
    const expired = Date.now() - 90 * 864e5;
    await seedLease(expired);
    await assertFails(write(database(), leasedId(expired)));
    await seedLease(issued);
    await environment.withSecurityRulesDisabled(async (context) => deleteDoc(doc(context.firestore(), leasePath())));
    await seedLease(issued + 1);
    await assertFails(write(database(), leasedId(issued)));
  }
});

test('existing transaction implementations accept explicit leased IDs for all four kinds', async () => {
  const issued = Date.now() - 1000;
  await seedLease(issued);
  await seedPolicy(true);
  const ids = [0, 1, 2, 3].map((i) => leasedId(issued).replace(eventUuid, `3af12345-1234-4123-8123-123456789ab${i}`));
  const sdk = { doc, runTransaction, serverTimestamp };
  const firestore = database();
  const events = [progressEvent(ids[0], 30), bookmarkEvent(ids[1]), annotationEvent(ids[2]), paletteEvent(ids[3])];
  for (const event of events) event.deviceId = 'device-1';
  const functions = [applyProgressEventTransaction, applyBookmarkEventTransaction, applyAnnotationEventTransaction, applyAnnotationPaletteEventTransaction];
  for (let i = 0; i < functions.length; i++) {
    const result = await functions[i]({ event: events[i], uid: 'alice', libraryScopeKey: 'library:local', firestore, sdk });
    assert.equal(result.status, 'apply');
  }
});

test('client serverTimestamp lease is usable with its floored millisecond ID', async () => {
  const db = database();
  await assertSucceeds(setDoc(doc(db, leasePath()), { schemaVersion: 1, deviceId: 'device-1', issuedAtServer: serverTimestamp() }));
  const snapshot = await getDoc(doc(db, leasePath()));
  const issued = Math.floor(snapshot.data().issuedAtServer.toMillis());
  await assertSucceeds(writeAnnotationEvent(db, leasedId(issued)));
});

test('receipt maintenance pages missing parents and deletes only their eligible receipts', async () => {
  const { initializeApp, deleteApp } = await import('firebase-admin/app');
  const { getFirestore, Timestamp: AdminTimestamp } = await import('firebase-admin/firestore');
  const { adminMaintenanceDependencies, maintenanceAdmin } = await import('../src/server/syncReceiptMaintenance.ts');
  const adminApp = initializeApp({ projectId }, 'receipt-maintenance-emulator-test');
  const adminDb = getFirestore(adminApp);
  const root = `artifacts/${appId}/users/alice/libraries/local`;
  const now = Date.now();
  const old = AdminTimestamp.fromMillis(now - 121 * 864e5);
  const receipt = (bookId, eventId) => ({
    schemaVersion: 2, eventId, targetKind: 'progress', bookId, bookmarkId: null,
    targetKey: `progress:${bookId}`, revision: 1, createdAtServer: old,
  });
  try {
    await adminDb.doc(`${root}/syncPolicyV1/writeLease`).set({ schemaVersion: 1, requireLeases: true, legacyBlockedAtServer: old });
    await adminDb.doc(`${root}/readingHistoryV2/a-missing/eventReceipts/one`).set(receipt('a-missing', 'one'));
    await adminDb.doc(`${root}/readingHistoryV2/b-existing`).set({ head: true });
    await adminDb.doc(`${root}/readingHistoryV2/b-existing/eventReceipts/two`).set(receipt('b-existing', 'two'));
    await adminDb.doc(`${root}/readingHistoryV2/a-missing/eventReceipts/000-young`).set({ ...receipt('a-missing', '000-young'), createdAtServer: AdminTimestamp.fromMillis(now) });
    for (let index = 0; index < 51; index++) {
      const id = `old-${String(index).padStart(2, '0')}`;
      await adminDb.doc(`${root}/readingHistoryV2/a-missing/eventReceipts/${id}`).set({ ...receipt('a-missing', id),
        createdAtServer: AdminTimestamp.fromMillis(now - (122 + index % 2) * 864e5) });
    }
    assert.equal((await adminDb.doc(`${root}/readingHistoryV2/a-missing`).get()).exists, false);
    const deps = adminMaintenanceDependencies(adminDb);
    const first = await deps.listParent(root, 'readingHistoryV2', '');
    assert.equal(first.id, 'a-missing'); assert.ok(first.nextToken);
    const second = await deps.listParent(root, 'readingHistoryV2', first.nextToken);
    assert.equal(second.id, 'b-existing');
    if (second.nextToken) assert.equal((await deps.listParent(root, 'readingHistoryV2', second.nextToken)).id, null);
    const result = await maintenanceAdmin('alice', deps, { dryRun: false });
    assert.equal(result.status, 'complete'); assert.equal(result.scanned, 53); assert.equal(result.deleted, 53);
    assert.equal((await adminDb.doc(`${root}/readingHistoryV2/a-missing/eventReceipts/000-young`).get()).exists, true);
    assert.equal((await adminDb.doc(`${root}/readingHistoryV2/a-missing/eventReceipts/one`).get()).exists, false);
    assert.equal((await adminDb.doc(`${root}/readingHistoryV2/b-existing/eventReceipts/two`).get()).exists, false);
    assert.deepEqual((await adminDb.doc(`${root}/readingHistoryV2/b-existing`).get()).data(), { head: true });
  } finally {
    await deleteApp(adminApp);
  }
});


test('prepared server lease creates an event accepted by the progress transaction', async () => {
  const require = createRequire(import.meta.url);
  const cjsRules = require('@firebase/rules-unit-testing');
  const cjsFirestore = require('firebase/firestore');
  const cjsEnvironment = await cjsRules.initializeTestEnvironment({ projectId });
  const previous = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  try {
    await seedPolicy(true);
    const firestore = cjsEnvironment.authenticatedContext('alice').firestore();
    const owner = 'firebase:alice|library:local';
    const lease = await prepareWriteLease(firestore, 'alice', owner, 'device-1');
    const eventId = createSyncEventId(owner, 'device-1');
    const parsed = parseLeasedEventId(eventId);
    assert.equal(parsed?.leaseId, lease.leaseId);
    assert.equal(parsed?.issuedAtMillis, lease.issuedAtMillis);
    const snapshot = await cjsFirestore.getDoc(cjsFirestore.doc(firestore, `artifacts/${appId}/users/alice/libraries/local/writeLeases/${lease.leaseId}`));
    assert.equal(Math.floor(snapshot.data().issuedAtServer.toMillis()), lease.issuedAtMillis);
    const event = progressEvent(eventId, 30);
    event.deviceId = 'device-1';
    const result = await applyProgressEventTransaction({ event, uid: 'alice', firestore, sdk: cjsFirestore });
    assert.equal(result.status, 'apply');
    assert.equal((await cjsFirestore.getDoc(cjsFirestore.doc(firestore, `${progressPath()}/eventReceipts/${eventId}`))).exists(), true);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previous;
    await cjsEnvironment.cleanup();
  }
});
