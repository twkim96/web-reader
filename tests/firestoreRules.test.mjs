import test, { after, before } from 'node:test';
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
  serverTimestamp,
  setDoc,
  writeBatch,
} from 'firebase/firestore';

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

test('keeps compatible v1 reads, writes and deletes scoped to the uid', async () => {
  const path = `artifacts/${appId}/users/alice/readingHistory/book-1`;
  const own = database();
  await assertSucceeds(setDoc(doc(own, path), {
    bookId: 'book-1',
    cfi: '',
    progressPercent: 0,
    lastRead: serverTimestamp(),
    bookmarks: [],
    deviceId: 'old-device',
  }));
  await assertSucceeds(deleteDoc(doc(own, path)));
  await assertFails(setDoc(doc(database('mallory'), path), {
    bookId: 'book-1',
    progressPercent: 10,
  }));
  assert.ok(true);
});
