import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';
import { applyProgressEventTransaction } from '../src/lib/progressSyncTransaction.ts';
import { applyBookmarkEventTransaction } from '../src/lib/bookmarkSyncTransaction.ts';
import {
  applyAnnotationEventTransaction,
  applyAnnotationPaletteEventTransaction,
} from '../src/lib/annotationSyncTransaction.ts';
import { DEFAULT_ANNOTATION_PALETTE } from '../src/lib/annotationPalette.ts';
import { uploadReadingSessionV1 } from '../src/lib/readingStatisticsSync.ts';
import { getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';

const projectId = 'demo-web-reader';
const appId = 'private-web-novel-viewer';
let environment;

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
});

const database = (uid = 'alice') => environment
  .authenticatedContext(uid)
  .firestore();

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

const validHead = (eventId = 'event-1', revision = 1) => ({
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

const validReceipt = (eventId = 'event-1', revision = 1) => ({
  schemaVersion: 2,
  eventId,
  targetKind: 'progress',
  bookId: 'book-1',
  bookmarkId: null,
  targetKey: 'progress:book-1',
  revision,
  createdAtServer: serverTimestamp(),
});

const writeProgressEvent = (db, eventId = 'event-1', revision = 1) => {
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
  eventId = 'bookmark-event-1',
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

const validBookmarkReceipt = (eventId = 'bookmark-event-1', revision = 1) => ({
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
  eventId = 'bookmark-event-1',
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
  eventId = 'annotation-event-1',
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

const validAnnotationReceipt = (eventId = 'annotation-event-1', revision = 1) => ({
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
  eventId = 'annotation-event-1',
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
  eventId = 'annotation-event-1',
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

const validPaletteHead = (eventId = 'palette-event-1', revision = 1) => ({
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

const validPaletteReceipt = (eventId = 'palette-event-1', revision = 1) => ({
  schemaVersion: 1,
  eventId,
  targetKind: 'palette',
  bookId: null,
  annotationId: null,
  targetKey: 'annotation-palette',
  revision,
  createdAtServer: serverTimestamp(),
});

const writePaletteEvent = (db, eventId = 'palette-event-1', revision = 1) => {
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
  deviceId: `device-${eventId}`,
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
  deviceId: `device-${eventId}`,
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
  deviceId: `device-${eventId}`,
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
  deviceId: `device-${eventId}`,
  sessionId: `session-${eventId}`,
  baseRevision,
  occurredAtClient: baseRevision + 1,
});

test('allows own atomic progress head and immutable receipt', async () => {
  const db = database();
  await assertSucceeds(writeProgressEvent(db));
  await assertSucceeds(getDoc(doc(db, progressPath())));
  await assertFails(setDoc(
    doc(db, `${progressPath()}/eventReceipts/event-1`),
    validReceipt('event-1', 1),
  ));
  await assertFails(deleteDoc(doc(db, `${progressPath()}/eventReceipts/event-1`)));
});

test('rejects another uid and orphan head or receipt writes', async () => {
  await assertFails(getDoc(doc(database('mallory'), progressPath('alice'))));
  await assertFails(setDoc(doc(database(), progressPath()), validHead()));
  await assertFails(setDoc(
    doc(database(), `${progressPath()}/eventReceipts/event-1`),
    validReceipt(),
  ));
});

test('rejects revision jumps, unknown fields and invalid progress range', async () => {
  const db = database();
  await assertSucceeds(writeProgressEvent(db));

  const jump = writeBatch(db);
  jump.set(doc(db, progressPath()), validHead('event-3', 3));
  jump.set(doc(db, `${progressPath()}/eventReceipts/event-3`), validReceipt('event-3', 3));
  await assertFails(jump.commit());

  const invalid = writeBatch(db);
  invalid.set(doc(db, progressPath()), {
    ...validHead('event-2', 2),
    unknown: true,
    position: { cfi: 'x', anchorCfi: null, progressPercent: 101 },
  });
  invalid.set(doc(db, `${progressPath()}/eventReceipts/event-2`), validReceipt('event-2', 2));
  await assertFails(invalid.commit());
});

test('allows atomic bookmark upsert and revisioned tombstone delete', async () => {
  const db = database();
  await assertSucceeds(writeBookmarkEvent(db));
  await assertSucceeds(writeBookmarkEvent(db, 'bookmark-event-2', 2, 'delete'));
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
    ...validBookmarkHead('bookmark-event-2', 2),
    bookmarkId: 'other-mark',
  });
  mismatch.set(
    doc(db, `${progressPath()}/eventReceipts/bookmark-event-2`),
    validBookmarkReceipt('bookmark-event-2', 2),
  );
  await assertFails(mismatch.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, bookmarkPath()), validBookmarkHead('bookmark-event-3', 3));
  jump.set(
    doc(db, `${progressPath()}/eventReceipts/bookmark-event-3`),
    validBookmarkReceipt('bookmark-event-3', 3),
  );
  await assertFails(jump.commit());

  await assertFails(setDoc(
    doc(db, `${progressPath()}/eventReceipts/orphan-bookmark-event`),
    validBookmarkReceipt('orphan-bookmark-event', 2),
  ));
  await assertFails(getDoc(doc(database('mallory'), bookmarkPath())));
});

test('runs concurrent progress transactions with one winner, receipt replay, reset, and stale conflict', async () => {
  const firstEvent = progressEvent('concurrent-a', 30);
  const secondEvent = progressEvent('concurrent-b', 70);
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
    event: progressEvent('reset-event', 0, 1, 'progress.reset'),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(reset.status, 'apply');
  assert.equal(reset.head.revision, 2);
  assert.equal(reset.head.operation, 'reset');

  const stale = await applyProgressEventTransaction({
    event: progressEvent('stale-set', 90, 1),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 2);
});

test('runs bookmark transaction receipt replay, tombstone, and stale edit conflict', async () => {
  const upsertEvent = bookmarkEvent('bookmark-upsert');
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
    event: bookmarkEvent('bookmark-delete', 1, 'bookmark.delete'),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.operation, 'delete');
  assert.equal(deletion.head.revision, 2);

  const stale = await applyBookmarkEventTransaction({
    event: bookmarkEvent('bookmark-stale', 1),
    uid: 'alice',
    libraryScopeKey: 'library:local',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(stale.status, 'conflict');
  assert.equal(stale.remoteHead.revision, 2);
});

test('allows atomic annotation revisions, receipt replay, and tombstone delete', async () => {
  const firstEvent = annotationEvent('annotation-upsert');
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
    event: annotationEvent('annotation-delete', 1, 'annotation.delete'),
    uid: 'alice',
    firestore: database(),
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.operation, 'delete');
  assert.equal(deletion.head.revision, 2);
  await assertFails(deleteDoc(doc(database(), annotationPath())));
  await assertFails(setDoc(
    doc(database(), annotationReceiptPath('annotation-upsert')),
    validAnnotationReceipt('annotation-upsert', 1),
  ));
});

test('serializes concurrent different ids and rejects a duplicate remote range', async () => {
  const db = database();
  const rangeCfi = 'epubcfi(/6/4!/4/2,/1:0,/1:4)';
  const eventFor = (annotationId) => ({
    eventId: `event-${annotationId}`,
    target: { kind: 'annotation', bookId: 'book-1', annotationId },
    targetKey: `annotation:book-1:${annotationId}`,
    operation: 'annotation.upsert',
    payload: {
      ...validAnnotationPayload(),
      id: annotationId,
      rangeCfi,
      quote: `문장 ${annotationId}`,
    },
    deviceId: `device-${annotationId}`,
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

test('applies a forced book-deletion tombstone at the latest server revision', async () => {
  const db = database();
  await applyAnnotationEventTransaction({
    event: annotationEvent('force-delete-upsert'),
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  const deletion = await applyAnnotationEventTransaction({
    event: {
      ...annotationEvent('force-delete-tombstone', 0, 'annotation.delete'),
      forceDelete: true,
    },
    uid: 'alice',
    firestore: db,
    sdk: { doc, runTransaction, serverTimestamp },
  });
  assert.equal(deletion.status, 'apply');
  assert.equal(deletion.head.revision, 2);
  assert.equal(deletion.head.operation, 'delete');
});

test('book deletion marker blocks stale offline upserts but allows a new highlight', async () => {
  const db = database();
  const markerEvent = {
    eventId: 'book-delete-marker',
    target: {
      kind: 'annotation',
      bookId: 'book-1',
      annotationId: 'book_delete_marker_v1',
    },
    targetKey: 'annotation:book-1:book_delete_marker_v1',
    operation: 'annotation.delete',
    payload: null,
    deviceId: 'deleting-device',
    sessionId: 'deleting-session',
    baseRevision: 0,
    forceDelete: true,
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
    deviceId: `device-${id}`,
    sessionId: `session-${id}`,
    baseRevision: 0,
    bookGeneration,
    occurredAtClient,
  });
  const stale = eventFor(
    'stale-offline',
    'epubcfi(/6/4!/4/2,/1:0,/1:4)',
    'stale-offline-event',
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
    ...validAnnotationHead('malicious-stale-event'),
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
  malicious.set(doc(db, annotationReceiptPath('malicious-stale-event')), {
    ...validAnnotationReceipt('malicious-stale-event'),
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
    acceptedEventId: 'malicious-stale-event',
    acceptedAnnotationId: 'malicious-stale',
    acceptedOperation: 'upsert',
    updatedAtServer: serverTimestamp(),
  });
  await assertFails(malicious.commit());

  const fresh = eventFor(
    'fresh-highlight',
    'epubcfi(/6/4!/4/2,/1:5,/1:9)',
    'fresh-highlight-event',
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
    ...validAnnotationHead('annotation-event-2', 2),
    annotation: { ...validAnnotationPayload(), anchorState: 'unresolved' },
  });
  invalid.set(
    doc(db, annotationReceiptPath('annotation-event-2')),
    validAnnotationReceipt('annotation-event-2', 2),
  );
  await assertFails(invalid.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, annotationPath()), validAnnotationHead('annotation-event-3', 3));
  jump.set(
    doc(db, annotationReceiptPath('annotation-event-3')),
    validAnnotationReceipt('annotation-event-3', 3),
  );
  await assertFails(jump.commit());
  await assertFails(setDoc(
    doc(db, annotationReceiptPath('orphan-annotation')),
    validAnnotationReceipt('orphan-annotation', 2),
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
    const eventId = `invalid-annotation-${index}`;
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
  const eventId = 'multiline-annotation';
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
    validAnnotationAggregate('annotation-event-1', 2),
  ));
});

test('rejects an initial aggregate whose color count disagrees with its annotation', async () => {
  const db = database();
  const eventId = 'wrong-initial-color-count';
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
    eventId: `seed-${annotationId}`,
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
  const eventId = 'malicious-erase-b';
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
  const eventId = 'wrong-color-delta';
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
  const firstEvent = paletteEvent('palette-upsert');
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
    event: paletteEvent('palette-stale'),
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
    ...validPaletteHead('palette-event-2', 2),
    palette: { items: reversed },
  });
  invalid.set(
    doc(db, paletteReceiptPath('palette-event-2')),
    validPaletteReceipt('palette-event-2', 2),
  );
  await assertFails(invalid.commit());

  const jump = writeBatch(db);
  jump.set(doc(db, palettePath()), validPaletteHead('palette-event-3', 3));
  jump.set(
    doc(db, paletteReceiptPath('palette-event-3')),
    validPaletteReceipt('palette-event-3', 3),
  );
  await assertFails(jump.commit());
  await assertFails(setDoc(
    doc(db, paletteReceiptPath('orphan-palette')),
    validPaletteReceipt('orphan-palette', 2),
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
  assert.equal(await uploadReadingSessionV1(db, 'alice', record, sdk), 'created');
  assert.equal(await uploadReadingSessionV1(db, 'alice', record, sdk), 'replayed');
  const snapshot = await assertSucceeds(getDoc(doc(db, readingStatisticsPath())));
  assert.equal(snapshot.data().bookId, 'book-1');
  assert.equal(snapshot.data().durationMs, 60_000);
  await assert.rejects(
    uploadReadingSessionV1(db, 'alice', { ...record, bookTitle: 'Collision' }, sdk),
    /충돌/,
  );
  await assertFails(setDoc(doc(db, readingStatisticsPath()), {
    ...record,
    bookTitle: 'Updated',
    uploadedAtServer: serverTimestamp(),
  }));
  await assertFails(deleteDoc(doc(db, readingStatisticsPath())));
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
