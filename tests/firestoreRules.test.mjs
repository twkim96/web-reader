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
