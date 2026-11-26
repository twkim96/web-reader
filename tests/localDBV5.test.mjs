import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

const {
  closeLocalDB,
  initDB,
  subscribeLocalDBLifecycle,
} = await import('../src/lib/localDB.ts');
const {
  beginGuestReadingHandoff,
  clearGuestReadingHandoff,
  deleteOwnerLocalDataV5,
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  getOfflineBookIdsV5,
  loadBookFromLocalV5,
  loadProgressFromLocalV5,
  readGuestReadingHandoff,
  removeBookAndAnnotationsV8,
  removeBookFromLocalV5,
  retainReadingPositionsOnDeviceV5,
  restoreGuestReadingToAccountV5,
  saveArchiveInspectionToLocalV5,
  saveBookToLocalV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const {
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
} = await import('../src/lib/localAnnotations.ts');
const { getPendingLocalCommitCount } = await import('../src/lib/localCommitTracker.ts');
const {
  loadBookCoverFromLocalV14,
  saveBookCoverToLocalV14,
} = await import('../src/lib/bookCoverCache.ts');
const { getOutboxEventsV5, storeRemoteHeadsBatchV5 } = await import('../src/lib/syncOutboxV5.ts');
const { decideProgressTransaction } = await import('../src/lib/progressSyncTransaction.ts');
const schema = await import('../src/lib/localDBSchema.ts');
const {
  DEVICE_CONTENT_OWNER_KEY,
  makeFirebaseOwnerKey,
  makeOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('alice'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('bob'), 'library:local');

const deleteDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(schema.LOCAL_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('test database deletion was blocked'));
  });
};

const makeBook = (id, name = id) => ({
  id,
  name,
  mimeType: 'application/epub+zip',
  source: 'local',
});

test('lists cached book IDs for the requested content owner', async () => {
  await deleteDatabase();
  await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, makeBook('device-copy'), new Blob(['device']));
  await saveBookToLocalV5(ownerA, makeBook('account-copy'), new Blob(['account']));

  assert.deepEqual(await getOfflineBookIdsV5(DEVICE_CONTENT_OWNER_KEY), new Set(['device-copy']));
  assert.deepEqual(await getOfflineBookIdsV5(ownerA), new Set(['account-copy']));
  assert.deepEqual(await getOfflineBookIdsV5(ownerB), new Set());
});

test('retains the latest cached reading positions on logout without copying account bookmarks or sync state', async () => {
  await deleteDatabase();
  const guest = 'guest:device-reader|library:local';
  const position = (bookId, lastRead, progressPercent, extra = {}) => ({
    bookId, lastRead, progressPercent, cfi: 'cfi:' + lastRead, anchorCfi: 'anchor:' + lastRead, ...extra,
  });
  const guestBookmarks = [{ id: 'guest-mark', type: 'manual', cfi: 'guest-cfi' }];
  const accountPosition = position('account-newer', 20, 12, {
    bookmarks: [{ id: 'private-mark', type: 'manual', cfi: 'private-cfi' }],
    syncRevision: 7, acceptedEventId: 'account-event', localPositionToken: 'account-pending', ignoredRemoteRevision: 9,
  });
  for (const id of ['account-newer', 'guest-newer', 'same-time', 'reset']) {
    await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, makeBook(id), new Blob([id]));
  }
  await saveProgressToLocalV5(ownerA, accountPosition);
  await saveProgressToLocalV5(guest, position('account-newer', 10, 90, { bookmarks: guestBookmarks }));
  await saveProgressToLocalV5(guest, position('guest-newer', 30, 20));
  await saveProgressToLocalV5(ownerA, position('guest-newer', 20, 99));
  await saveProgressToLocalV5(guest, position('same-time', 20, 10));
  await saveProgressToLocalV5(ownerA, position('same-time', 20, 99));
  await saveProgressToLocalV5(guest, position('reset', 10, 50));
  await saveProgressToLocalV5(ownerA, position('reset', 20, 0, { cfi: '', anchorCfi: '' }));
  await saveProgressToLocalV5(ownerA, position('cloud-only', 30, 80));
  await saveProgressToLocalV5(ownerB, position('account-newer', 40, 50));

  await retainReadingPositionsOnDeviceV5(ownerA, guest);
  await retainReadingPositionsOnDeviceV5(ownerA, guest);
  const copied = await loadProgressFromLocalV5(guest, 'account-newer');
  assert.equal(copied.cfi, accountPosition.cfi);
  assert.equal(copied.anchorCfi, accountPosition.anchorCfi);
  assert.equal(copied.progressPercent, 12);
  assert.deepEqual(copied.bookmarks, guestBookmarks);
  for (const field of ['syncRevision', 'acceptedEventId', 'localPositionToken', 'ignoredRemoteRevision']) {
    assert.equal(copied[field], undefined);
  }
  assert.equal((await loadProgressFromLocalV5(guest, 'guest-newer')).cfi, 'cfi:30');
  assert.equal((await loadProgressFromLocalV5(guest, 'same-time')).progressPercent, 10);
  assert.equal((await loadProgressFromLocalV5(guest, 'reset')).progressPercent, 0);
  assert.equal(await loadProgressFromLocalV5(guest, 'cloud-only'), undefined);
  assert.equal((await loadProgressFromLocalV5(ownerA, 'account-newer')).syncRevision, 7);
  assert.equal((await loadProgressFromLocalV5(ownerB, 'account-newer')).cfi, 'cfi:40');
  assert.deepEqual(await getOutboxEventsV5(guest), []);
});

test('restarts a pending logout handoff and syncs newer guest positions only to the original account', async () => {
  await deleteDatabase();
  const guest = 'guest:device-reader|library:local';
  const bookId = 'resume-after-logout';
  const remoteFirst = 'remote-already-known';
  const remoteOlder = 'remote-older-than-guest';
  const lateAccountBook = 'late-account-tab';
  const lateGuestBook = 'late-guest-tab';
  const guestBookmark = { id: 'guest-mark', type: 'manual', cfi: 'guest-mark' };
  const privateBookmark = { id: 'account-mark', type: 'manual', cfi: 'account-mark' };
  const saved = (bookId, lastRead, progressPercent, fields = {}) => ({
    bookId, lastRead, progressPercent, cfi: 'cfi:' + progressPercent, ...fields,
  });
  for (const id of [bookId, remoteFirst, remoteOlder, lateAccountBook, lateGuestBook]) {
    await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, makeBook(id), new Blob([id]));
    await saveProgressToLocalV5(ownerA, saved(id, 20, 60, { syncRevision: 2, bookmarks: [privateBookmark] }));
    await saveProgressToLocalV5(guest, saved(id, 10, 10));
  }
  const handoff = await beginGuestReadingHandoff(ownerA, guest);
  await closeLocalDB();
  const recovered = await readGuestReadingHandoff(guest);
  assert.deepEqual(recovered, handoff);
  assert.equal((await loadProgressFromLocalV5(guest, bookId)).progressPercent, 10);
  await retainReadingPositionsOnDeviceV5(ownerA, guest, recovered);
  assert.equal((await loadProgressFromLocalV5(guest, bookId)).progressPercent, 60);
  assert.equal((await readGuestReadingHandoff(guest)).confirmed, true);
  await clearGuestReadingHandoff(handoff, true);
  assert.ok(await readGuestReadingHandoff(guest), 'failed logout cleanup cannot remove a completed handoff');

  const editTime = handoff.startedAt + 10;
  await saveProgressToLocalV5(ownerA, saved(lateAccountBook, editTime, 81, { syncRevision: 2 }));
  await retainReadingPositionsOnDeviceV5(ownerA, guest, recovered, true);
  assert.equal((await loadProgressFromLocalV5(guest, lateAccountBook)).progressPercent, 81);
  // Minutes of clock correction must not make a genuine guest edit disappear.
  const guestEditTime = handoff.startedAt - 5 * 60_000;
  await saveProgressToLocalV5(guest, saved(bookId, guestEditTime, 42, { bookmarks: [guestBookmark] }));
  await saveProgressToLocalV5(guest, saved(remoteFirst, guestEditTime, 42));
  await saveProgressToLocalV5(guest, saved(remoteOlder, editTime + 5 * 60_000, 42));
  await saveProgressToLocalV5(guest, saved(lateAccountBook, editTime, 81, { bookmarks: [guestBookmark] }), false);
  const published = editTime + 100;
  const remoteHead = {
    schemaVersion: 2, bookId: remoteFirst, revision: 3, acceptedEventId: 'other-reader', operation: 'set',
    position: { cfi: 'other', anchorCfi: null, progressPercent: 33 }, acceptedDeviceId: 'other-device',
    updatedAtServer: { seconds: Math.floor(published / 1000), nanoseconds: (published % 1000) * 1_000_000 },
    occurredAtClient: 1, deletedAtServer: null,
  };
  const olderHead = { ...remoteHead, bookId: remoteOlder, updatedAtServer: { seconds: 1, nanoseconds: 0 } };
  await storeRemoteHeadsBatchV5(ownerA, [remoteHead, olderHead]);
  await saveProgressToLocalV5(ownerA, saved(remoteFirst, published, 33, { syncRevision: 3, acceptedEventId: 'other-reader' }));
  await Promise.all(['fixture-session', 'second-tab'].map((session) =>
    restoreGuestReadingToAccountV5(ownerA, guest, 'fixture-device', session, () => true)));
  const resumed = await loadProgressFromLocalV5(ownerA, bookId);
  assert.equal(resumed.progressPercent, 42, 'latest can be an intentional move backwards');
  assert.equal(resumed.lastRead, guestEditTime);
  assert.deepEqual(resumed.bookmarks, [privateBookmark]);
  assert.equal((await loadProgressFromLocalV5(ownerA, remoteFirst)).progressPercent, 42);
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(events.length, 3);
  const imported = events.find(event => event.target.bookId === bookId);
  assert.equal(imported.baseRevision, 2);
  assert.equal(imported.occurredAtClient, guestEditTime);
  assert.equal(decideProgressTransaction({
    event: imported, storedHead: { ...remoteHead, bookId }, storedReceipt: undefined, serverTime: published,
  }).status, 'conflict', 'a late different-device revision still goes through normal conflict handling');
  assert.equal(decideProgressTransaction({
    event: events.find(event => event.target.bookId === remoteFirst), storedHead: remoteHead,
    storedReceipt: undefined, serverTime: published,
  }).status, 'conflict', 'recovery or re-login seeing a newer head does not change the logout base revision');
  assert.equal(decideProgressTransaction({
    event: events.find(event => event.target.bookId === remoteOlder), storedHead: olderHead,
    storedReceipt: undefined, serverTime: published,
  }).status, 'conflict', 'a fast guest clock cannot promote the cached server head to the logout baseline');
  await saveProgressToLocalV5(guest, saved(lateGuestBook, editTime + 1, 83));
  await restoreGuestReadingToAccountV5(ownerA, guest, 'fixture-device', 'fixture-session', () => true);
  assert.equal((await loadProgressFromLocalV5(ownerA, lateGuestBook)).progressPercent, 83);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 4, 'a second tab only queues the newly flushed guest row');

  const otherHandoff = await beginGuestReadingHandoff(ownerA, guest);
  await retainReadingPositionsOnDeviceV5(ownerA, guest, otherHandoff);
  await saveProgressToLocalV5(guest, saved(bookId, otherHandoff.startedAt + 10, 77));
  await restoreGuestReadingToAccountV5(ownerB, guest, 'fixture-device', 'fixture-session', () => true);
  assert.equal(await loadProgressFromLocalV5(ownerB, bookId), undefined);
  assert.deepEqual(await getOutboxEventsV5(ownerB), []);
  assert.equal(await readGuestReadingHandoff(guest), undefined);

  const interrupted = await beginGuestReadingHandoff(ownerA, guest);
  await restoreGuestReadingToAccountV5(ownerB, guest, 'fixture-device', 'fixture-session', () => true);
  await retainReadingPositionsOnDeviceV5(ownerA, guest, interrupted);
  assert.equal(await readGuestReadingHandoff(guest), undefined, 'another account clears an abandoned pending logout');

  const failed = await beginGuestReadingHandoff(ownerA, guest);
  await clearGuestReadingHandoff(failed, true);
  await retainReadingPositionsOnDeviceV5(ownerA, guest, failed);
  assert.equal(await readGuestReadingHandoff(guest), undefined);
});

test('imports a pending legacy guest edit without adopting a newer account revision', async () => {
  await deleteDatabase();
  const guest = 'guest:legacy-guest|library:local';
  const bookId = 'legacy-guest-edit';
  await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, makeBook(bookId), new Blob(['book']));
  await saveProgressToLocalV5(ownerA, { bookId, cfi: 'account', progressPercent: 60, lastRead: 500, syncRevision: 2 });
  await saveProgressToLocalV5(guest, { bookId, cfi: 'guest', progressPercent: 40, lastRead: 200 });
  const db = await initDB();
  await db.put(schema.V5_SYNC_META_STORE, {
    ownerKey: guest, account: ownerA, targetKey: 'guest-reading-handoff', attemptId: 'legacy', startedAt: 100, confirmed: true,
  });

  await restoreGuestReadingToAccountV5(ownerA, guest, 'device', 'session', () => true, bookId);
  await restoreGuestReadingToAccountV5(ownerA, guest, 'device', 'session', () => true, bookId);
  const [event] = await getOutboxEventsV5(ownerA);
  assert.equal(event.baseRevision, 0, 'unknown logout revision goes through normal conflict handling');
  assert.equal(event.payload.progressPercent, 40);
  assert.equal((await getOutboxEventsV5(ownerA)).length, 1);
});

test('preserves a guest edit across logout while its account target requires expired-event recovery', async (t) => {
  await deleteDatabase();
  const previousFlag = process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES;
    else process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = previousFlag;
  });
  const guest = 'guest:device-reader|library:local';
  const bookId = 'expired-book';
  await saveBookToLocalV5(DEVICE_CONTENT_OWNER_KEY, makeBook(bookId), new Blob(['book']));
  await saveProgressToLocalV5(ownerA, { bookId, cfi: 'account', progressPercent: 60, lastRead: 10 });
  const handoff = await beginGuestReadingHandoff(ownerA, guest);
  await retainReadingPositionsOnDeviceV5(ownerA, guest, handoff);
  const lastRead = handoff.startedAt + 1;
  await saveProgressToLocalV5(guest, { bookId, cfi: 'guest', progressPercent: 75, lastRead });
  const db = await initDB();
  const oldEvent = {
    ownerKey: ownerA, eventId: 'expired-event', targetKey: 'progress:expired-book',
    target: { kind: 'progress', bookId }, status: 'expired', recoveryPending: true, sequence: 1,
  };
  await db.put(schema.V5_OUTBOX_STORE, oldEvent);
  process.env.NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES = '1';
  assert.equal(await restoreGuestReadingToAccountV5(ownerA, guest, 'device', 'session', () => true, bookId), undefined);
  assert.equal((await loadProgressFromLocalV5(ownerA, bookId)).progressPercent, 60);

  const repeatLogout = await beginGuestReadingHandoff(ownerA, guest);
  assert.equal(repeatLogout.startedAt, handoff.startedAt, 'the delayed edit remains eligible across another logout');
  await retainReadingPositionsOnDeviceV5(ownerA, guest, repeatLogout);
  await db.put(schema.V5_OUTBOX_STORE, { ...oldEvent, recoveryPending: false, status: 'superseded' });
  const imported = await restoreGuestReadingToAccountV5(ownerA, guest, 'device', 'session', () => true, bookId);
  assert.equal(imported.progressPercent, 75);
  assert.equal(imported.lastRead, lastRead);
});

const makeAnnotation = (ownerBookId, id, colorId = 'yellow') => ({
  id,
  bookId: ownerBookId,
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: `epubcfi(/6/2!/4/2,/1:${id.length},/1:${id.length + 1})`,
  quote: `quote ${id}`,
  prefix: 'before',
  suffix: 'after',
  colorId,
  note: '',
  progressPercent: 10,
  chapter: 'Chapter 1',
  createdAtClient: 100,
  updatedAtClient: 100,
  anchorState: 'active',
});

const seedLegacyV4 = async ({ invalidMetadata = false } = {}) => {
  const db = await openDB(schema.LOCAL_DB_NAME, 4, {
    upgrade(database) {
      database.createObjectStore(schema.LEGACY_BOOKS_STORE);
      database.createObjectStore(schema.LEGACY_METADATA_STORE, { keyPath: 'id' });
      database.createObjectStore(schema.LEGACY_PROGRESS_STORE, { keyPath: 'bookId' });
      database.createObjectStore(schema.LEGACY_ARCHIVE_INSPECTIONS_STORE, { keyPath: 'bookId' });
    },
  });
  const tx = db.transaction([
    schema.LEGACY_BOOKS_STORE,
    schema.LEGACY_METADATA_STORE,
    schema.LEGACY_PROGRESS_STORE,
    schema.LEGACY_ARCHIVE_INSPECTIONS_STORE,
  ], 'readwrite');
  await tx.objectStore(schema.LEGACY_BOOKS_STORE).put(new Blob(['alpha']), 'same-id');
  await tx.objectStore(schema.LEGACY_BOOKS_STORE).put(new Uint8Array([1, 2, 3]).buffer, 'second');
  await tx.objectStore(schema.LEGACY_METADATA_STORE).put(
    invalidMetadata ? 'invalid-record' : makeBook('same-id', 'Alpha'),
    invalidMetadata ? 'bad' : undefined,
  );
  if (!invalidMetadata) {
    await tx.objectStore(schema.LEGACY_METADATA_STORE).put(makeBook('second', 'Second'));
  }
  await tx.objectStore(schema.LEGACY_PROGRESS_STORE).put({
    bookId: 'same-id', cfi: 'epubcfi(/6/2)', progressPercent: 25, lastRead: 10,
  });
  await tx.objectStore(schema.LEGACY_ARCHIVE_INSPECTIONS_STORE).put({
    bookId: 'same-id', fingerprint: 'fp', index: { entries: [] },
  });
  await tx.done;
  db.close();
};

const seedDeviceGlobalV6 = async () => {
  const db = await openDB(schema.LOCAL_DB_NAME, 6, {
    upgrade(database) {
      database.createObjectStore(schema.V5_BOOKS_STORE);
      const metadata = database.createObjectStore(schema.V5_METADATA_STORE, {
        keyPath: ['ownerKey', 'id'],
      });
      metadata.createIndex('by-owner', 'ownerKey');
      const progress = database.createObjectStore(schema.V5_PROGRESS_STORE, {
        keyPath: ['ownerKey', 'bookId'],
      });
      progress.createIndex('by-owner', 'ownerKey');
      const inspections = database.createObjectStore(schema.V5_ARCHIVE_INSPECTIONS_STORE, {
        keyPath: ['ownerKey', 'bookId'],
      });
      inspections.createIndex('by-owner', 'ownerKey');
      const outbox = database.createObjectStore(schema.LEGACY_V5_OUTBOX_STORE, {
        keyPath: ['ownerKey', 'eventId'],
      });
      outbox.createIndex('by-owner-status-next-attempt', ['ownerKey', 'status', 'nextAttemptAt']);
      outbox.createIndex('by-owner-target-sequence', ['ownerKey', 'targetKey', 'sequence']);
      const heads = database.createObjectStore(schema.V5_REMOTE_HEADS_STORE, {
        keyPath: ['ownerKey', 'targetKey'],
      });
      heads.createIndex('by-owner', 'ownerKey');
      const meta = database.createObjectStore(schema.V5_SYNC_META_STORE, {
        keyPath: ['ownerKey', 'targetKey'],
      });
      meta.createIndex('by-owner', 'ownerKey');
      const conflicts = database.createObjectStore(schema.V5_SYNC_CONFLICTS_STORE, {
        keyPath: ['ownerKey', 'conflictId'],
      });
      conflicts.createIndex('by-owner-target-state', ['ownerKey', 'targetKey', 'state']);
      database.createObjectStore(schema.V5_SYNC_LEASES_STORE, { keyPath: 'ownerKey' });
    },
  });
  const tx = db.transaction([
    schema.V5_BOOKS_STORE,
    schema.V5_METADATA_STORE,
    schema.V5_PROGRESS_STORE,
    schema.V5_ARCHIVE_INSPECTIONS_STORE,
    schema.LEGACY_V5_OUTBOX_STORE,
  ], 'readwrite');
  await tx.objectStore(schema.LEGACY_V5_OUTBOX_STORE).put({
    ownerKey: ownerA, eventId: 'v6-pending', targetKey: 'progress:book-6',
    sequence: 1, status: 'pending', nextAttemptAt: 1, payload: { cfi: 'original' },
  });
  await tx.objectStore(schema.V5_BOOKS_STORE).put(
    new Blob(['device-book']),
    [DEVICE_CONTENT_OWNER_KEY, 'book-6'],
  );
  await tx.objectStore(schema.V5_METADATA_STORE).put({
    ...makeBook('book-6', 'Device Global Book'),
    ownerKey: DEVICE_CONTENT_OWNER_KEY,
  });
  await tx.objectStore(schema.V5_PROGRESS_STORE).put({
    ownerKey: ownerA,
    bookId: 'book-6',
    cfi: 'v6-progress',
    progressPercent: 61,
    lastRead: 6,
    bookmarks: [
      { id: 'manual-1', type: 'manual', name: 'Manual', cfi: 'm', createdAt: 1, color: 'yellow' },
      { id: 'auto-1', type: 'auto', name: 'Auto', cfi: 'a', createdAt: 2, color: 'blue' },
    ],
  });
  await tx.objectStore(schema.V5_ARCHIVE_INSPECTIONS_STORE).put({
    ownerKey: DEVICE_CONTENT_OWNER_KEY,
    bookId: 'book-6',
    fingerprint: 'v6-inspection',
    index: { entries: [{ filename: '001.jpg' }] },
  });
  await tx.done;
  db.close();
};

test.beforeEach(deleteDatabase);
test.after(deleteDatabase);

test('fresh database creates only the new outbox with all indexes', async () => {
  const db = await initDB();
  assert.equal(db.objectStoreNames.contains(schema.LEGACY_V5_OUTBOX_STORE), false);
  assert.equal(db.objectStoreNames.contains(schema.V5_OUTBOX_STORE), true);
  const store = db.transaction(schema.V5_OUTBOX_STORE).store;
  assert.deepEqual(store.keyPath, ['ownerKey', 'eventId']);
  assert.deepEqual(Array.from(store.indexNames), [
    'by-owner-status', 'by-owner-status-next-attempt', 'by-owner-target-sequence',
  ]);
  assert.deepEqual(await store.getAll(), []);
});

test('v4 upgrade discards retired stores and creates the active schema', async () => {
  await seedLegacyV4();
  const db = await initDB();

  assert.equal(db.version, schema.LOCAL_DB_VERSION);
  for (const storeName of [
    schema.V5_BOOKS_STORE,
    schema.V5_METADATA_STORE,
    schema.V5_PROGRESS_STORE,
    schema.V5_ARCHIVE_INSPECTIONS_STORE,
    schema.V5_OUTBOX_STORE,
    schema.V5_REMOTE_HEADS_STORE,
    schema.V5_SYNC_META_STORE,
    schema.V5_SYNC_CONFLICTS_STORE,
    schema.V5_SYNC_LEASES_STORE,
    schema.V8_ANNOTATIONS_STORE,
    schema.V9_ANNOTATION_SETTINGS_STORE,
    schema.V10_ANNOTATION_BOOK_DELETIONS_STORE,
    schema.V14_BOOK_COVERS_STORE,
  ]) {
    assert.equal(db.objectStoreNames.contains(storeName), true, storeName);
  }
  for (const obsoleteStore of [
    schema.LEGACY_BOOKS_STORE,
    schema.LEGACY_METADATA_STORE,
    schema.LEGACY_PROGRESS_STORE,
    schema.LEGACY_ARCHIVE_INSPECTIONS_STORE,
    'owner-bindings-v5',
    'owner-session-v5',
    'migration-meta-v5',
  ]) {
    assert.equal(db.objectStoreNames.contains(obsoleteStore), false, obsoleteStore);
  }
});

test('v5 upgrade resets account-scoped book caches but preserves Firebase progress', async () => {
  const db = await openDB(schema.LOCAL_DB_NAME, 5, {
    upgrade(database) {
      database.createObjectStore(schema.V5_BOOKS_STORE);
      const metadata = database.createObjectStore(schema.V5_METADATA_STORE, {
        keyPath: ['ownerKey', 'id'],
      });
      metadata.createIndex('by-owner', 'ownerKey');
      const progress = database.createObjectStore(schema.V5_PROGRESS_STORE, {
        keyPath: ['ownerKey', 'bookId'],
      });
      progress.createIndex('by-owner', 'ownerKey');
      const inspections = database.createObjectStore(schema.V5_ARCHIVE_INSPECTIONS_STORE, {
        keyPath: ['ownerKey', 'bookId'],
      });
      inspections.createIndex('by-owner', 'ownerKey');
    },
  });
  const tx = db.transaction([
    schema.V5_BOOKS_STORE,
    schema.V5_METADATA_STORE,
    schema.V5_PROGRESS_STORE,
    schema.V5_ARCHIVE_INSPECTIONS_STORE,
  ], 'readwrite');
  await tx.objectStore(schema.V5_BOOKS_STORE).put(new Blob(['old-cache']), [ownerA, 'book-1']);
  await tx.objectStore(schema.V5_METADATA_STORE).put({
    ...makeBook('book-1', 'Old Account Cache'),
    ownerKey: ownerA,
  });
  await tx.objectStore(schema.V5_PROGRESS_STORE).put({
    ownerKey: ownerA,
    bookId: 'book-1',
    cfi: 'preserved',
    progressPercent: 42,
    lastRead: 1,
  });
  await tx.objectStore(schema.V5_ARCHIVE_INSPECTIONS_STORE).put({
    ownerKey: ownerA,
    bookId: 'book-1',
    fingerprint: 'old-cache',
    index: { entries: [] },
  });
  await tx.done;
  db.close();

  await initDB();
  assert.equal((await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY)).length, 0);
  assert.equal(await loadBookFromLocalV5(ownerA, 'book-1'), undefined);
  assert.deepEqual((await getAllLocalProgressV5(ownerA)).map(({ cfi }) => cfi), ['preserved']);
});

test('v6 upgrade preserves device-global books, metadata, inspections, and progress', async () => {
  await seedDeviceGlobalV6();

  const db = await initDB();
  assert.equal(await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'book-6')).text(), 'device-book');
  assert.deepEqual(
    (await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY)).map(({ name }) => name),
    ['Device Global Book'],
  );
  assert.deepEqual((await getAllLocalProgressV5(ownerA)).map(({ cfi }) => cfi), ['v6-progress']);
  assert.deepEqual(
    (await getAllLocalProgressV5(ownerA))[0].bookmarks.map(({ id, type }) => ({ id, type })),
    [
      { id: 'manual-1', type: 'manual' },
      { id: 'auto-1', type: 'auto' },
    ],
  );

  const tx = db.transaction([
    schema.V5_ARCHIVE_INSPECTIONS_STORE,
    schema.V5_OUTBOX_STORE,
    schema.V5_SYNC_CONFLICTS_STORE,
  ]);
  assert.equal(
    (await tx.objectStore(schema.V5_ARCHIVE_INSPECTIONS_STORE).get([
      DEVICE_CONTENT_OWNER_KEY,
      'book-6',
    ])).fingerprint,
    'v6-inspection',
  );
  assert.equal(tx.objectStore(schema.V5_OUTBOX_STORE).indexNames.contains('by-owner-status'), true);
  assert.deepEqual(
    (await tx.objectStore(schema.V5_OUTBOX_STORE).index('by-owner-status').getAll([ownerA, 'pending']))
      .map(({ eventId, payload }) => ({ eventId, payload })),
    [{ eventId: 'v6-pending', payload: { cfi: 'original' } }],
  );
  assert.equal(
    tx.objectStore(schema.V5_SYNC_CONFLICTS_STORE).indexNames.contains('by-owner-state-created-at'),
    true,
  );
});

test('a future index-only upgrade preserves all current active content stores', async () => {
  await seedDeviceGlobalV6();
  await initDB();
  await closeLocalDB();

  const db = await openDB(schema.LOCAL_DB_NAME, schema.LOCAL_DB_VERSION + 1, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      schema.upgradeLocalDB(database, transaction, oldVersion);
    },
  });
  assert.equal(
    await (await db.get(schema.V5_BOOKS_STORE, [DEVICE_CONTENT_OWNER_KEY, 'book-6'])).text(),
    'device-book',
  );
  assert.equal(
    (await db.get(schema.V5_METADATA_STORE, [DEVICE_CONTENT_OWNER_KEY, 'book-6'])).name,
    'Device Global Book',
  );
  assert.equal(
    (await db.get(schema.V5_ARCHIVE_INSPECTIONS_STORE, [DEVICE_CONTENT_OWNER_KEY, 'book-6'])).fingerprint,
    'v6-inspection',
  );
  db.close();
});

test('device books survive Firebase progress owner deletion', async () => {
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  await saveProgressToLocalV5(ownerA, {
    bookId: 'same-id', cfi: 'a', progressPercent: 10, lastRead: 1,
  });
  await saveProgressToLocalV5(ownerB, {
    bookId: 'same-id', cfi: 'b', progressPercent: 90, lastRead: 2,
  });
  await saveArchiveInspectionToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    'same-id',
    'device',
    { entries: [] },
  );

  assert.equal(
    await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id')).text(),
    'device-book',
  );
  assert.deepEqual(
    (await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY)).map(({ name }) => name),
    ['Device Book'],
  );
  assert.deepEqual((await getAllLocalProgressV5(ownerB)).map(({ cfi }) => cfi), ['b']);

  await deleteOwnerLocalDataV5(ownerA);
  assert.equal(
    await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id')).text(),
    'device-book',
  );
  assert.equal((await getAllLocalProgressV5(ownerA)).length, 0);
  assert.equal((await getAllLocalProgressV5(ownerB)).length, 1);
});

test('removing only a device copy preserves owner progress and annotations', async () => {
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  await saveProgressToLocalV5(ownerA, {
    bookId: 'same-id', cfi: 'owner-position', progressPercent: 42, lastRead: 1,
  });
  await saveLocalAnnotationV8(ownerA, makeAnnotation('same-id', 'owner-note'));
  await saveBookCoverToLocalV14(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['cover'], { type: 'image/webp' }),
  );

  await removeBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id');

  assert.equal(await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id'), undefined);
  assert.equal(
    await loadBookCoverFromLocalV14(
      DEVICE_CONTENT_OWNER_KEY,
      makeBook('same-id', 'Device Book'),
    ),
    null,
  );
  assert.deepEqual((await getAllLocalProgressV5(ownerA)).map(({ cfi }) => cfi), ['owner-position']);
  assert.equal((await getLocalAnnotationsV8(ownerA, 'same-id')).length, 1);
});

test('loads only a current fingerprinted book cover without rebuilding it', async () => {
  const current = {
    ...makeBook('cover-book', 'Cover Book.epub'),
    size: 1024,
    modifiedTime: '2026-08-20T00:00:00.000Z',
  };
  await saveBookCoverToLocalV14(
    DEVICE_CONTENT_OWNER_KEY,
    current,
    new Blob(['cached-cover'], { type: 'image/webp' }),
  );

  const loaded = await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, current);
  assert.equal(await loaded.text(), 'cached-cover');
  assert.equal(
    await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, {
      ...current,
      modifiedTime: '2026-08-21T00:00:00.000Z',
    }),
    null,
  );
});

test('atomically removes one device book and only the current owner annotations', async () => {
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  await saveArchiveInspectionToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    'same-id',
    'device',
    { entries: [] },
  );
  await saveBookCoverToLocalV14(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['cover'], { type: 'image/webp' }),
  );
  await saveLocalAnnotationV8(ownerA, makeAnnotation('same-id', 'owner-a'));
  await saveLocalAnnotationV8(ownerA, makeAnnotation('other-id', 'other-book'));
  await saveLocalAnnotationV8(ownerB, makeAnnotation('same-id', 'owner-b', 'blue'));

  const removing = removeBookAndAnnotationsV8(
    ownerA,
    DEVICE_CONTENT_OWNER_KEY,
    'same-id',
  );
  assert.equal(getPendingLocalCommitCount(), 1);
  assert.deepEqual(await removing, { annotationsDeleted: 1, tombstonesQueued: 0 });
  assert.equal(getPendingLocalCommitCount(), 0);
  assert.equal(await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id'), undefined);
  assert.equal(
    await loadBookCoverFromLocalV14(
      DEVICE_CONTENT_OWNER_KEY,
      makeBook('same-id', 'Device Book'),
    ),
    null,
  );
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'same-id'), []);
  assert.equal((await getLocalAnnotationsV8(ownerA, 'other-id')).length, 1);
  assert.equal((await getLocalAnnotationsV8(ownerB, 'same-id')).length, 1);
});

test('atomically queues only the marker with authenticated book deletion', async () => {
  let eventSequence = 0;
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  await saveLocalAnnotationV8(ownerA, makeAnnotation('same-id', 'owner-a'));
  await removeBookAndAnnotationsV8(
    ownerA,
    DEVICE_CONTENT_OWNER_KEY,
    'same-id',
    {
      deviceId: 'device-a',
      sessionId: 'session-a',
      createEventId: () => `delete-annotation-event-${eventSequence += 1}`,
    },
  );
  assert.equal(await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id'), undefined);
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'same-id'), []);
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(events.length, 1);
  const [marker] = events;
  assert.equal(marker.target.annotationId, 'book_delete_marker_v1');
  assert.equal(marker.operation, 'annotation.delete');
  const db = await initDB();
  const intent = await db.get(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerA, 'same-id']);
  assert.equal(intent.markerEventId, marker.eventId);
  assert.equal(intent.markerRevision, undefined);
});

test('defers remote-only tombstones until the marker is acknowledged', async () => {
  let eventSequence = 0;
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  const result = await removeBookAndAnnotationsV8(
    ownerA,
    DEVICE_CONTENT_OWNER_KEY,
    'same-id',
    {
      deviceId: 'device-a',
      sessionId: 'session-a',
      createEventId: () => `remote-only-delete-${eventSequence += 1}`,
    },
  );
  assert.deepEqual(result, { annotationsDeleted: 0, tombstonesQueued: 1 });
  const events = await getOutboxEventsV5(ownerA);
  assert.deepEqual(events.map(event => event.target.annotationId), ['book_delete_marker_v1']);
});

test('aborts the combined book deletion when one store operation fails', async () => {
  await saveBookToLocalV5(
    DEVICE_CONTENT_OWNER_KEY,
    makeBook('same-id', 'Device Book'),
    new Blob(['device-book']),
  );
  await saveLocalAnnotationV8(ownerA, makeAnnotation('same-id', 'owner-a'));

  const originalDelete = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.delete = function deleteWithFailure(key) {
    if (this.name === schema.V5_METADATA_STORE) {
      throw new Error('injected metadata delete failure');
    }
    return originalDelete.call(this, key);
  };
  try {
    await assert.rejects(
      removeBookAndAnnotationsV8(ownerA, DEVICE_CONTENT_OWNER_KEY, 'same-id'),
      /injected metadata delete failure/,
    );
  } finally {
    IDBObjectStore.prototype.delete = originalDelete;
  }

  assert.equal(
    await (await loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, 'same-id')).text(),
    'device-book',
  );
  assert.equal((await getLocalAnnotationsV8(ownerA, 'same-id')).length, 1);
});

test('blocked current-schema open is reported and resumes after the old connection closes', async () => {
  const oldConnection = await openDB(schema.LOCAL_DB_NAME, 4, {
    upgrade(database) {
      database.createObjectStore(schema.LEGACY_BOOKS_STORE);
      database.createObjectStore(schema.LEGACY_METADATA_STORE, { keyPath: 'id' });
      database.createObjectStore(schema.LEGACY_PROGRESS_STORE, { keyPath: 'bookId' });
      database.createObjectStore(schema.LEGACY_ARCHIVE_INSPECTIONS_STORE, { keyPath: 'bookId' });
    },
  });
  let blockedEvent;
  const blocked = new Promise((resolve) => {
    const unsubscribe = subscribeLocalDBLifecycle((event) => {
      if (event.type !== 'blocked') return;
      blockedEvent = event;
      unsubscribe();
      resolve();
    });
  });

  const opening = initDB();
  await blocked;
  assert.equal(blockedEvent.targetVersion, schema.LOCAL_DB_VERSION);
  oldConnection.close();
  assert.equal((await opening).version, schema.LOCAL_DB_VERSION);
});

for (const [version, outboxStore] of [[14, schema.LEGACY_V5_OUTBOX_STORE], [15, schema.V15_OUTBOX_STORE]]) {
  test(`v${version} outbox rename preserves queued records and other active stores atomically`, async () => {
    const previous = await openDB(schema.LOCAL_DB_NAME, version, {
      upgrade(db, oldVersion, _newVersion, tx) {
        schema.upgradeLocalDB(db, tx, oldVersion);
        tx.objectStore(schema.V5_OUTBOX_STORE).name = outboxStore;
      },
    });
    const statuses = ['pending', 'in_flight', 'paused', 'conflict', 'superseded', 'blocked'];
    const records = statuses.map((status, index) => ({
      ownerKey: ownerA, eventId: `legacy-${index}`, targetKey: 'progress:book',
      sequence: index + 1, status, attempts: index, nextAttemptAt: 42,
      payload: { value: index }, claimToken: index === 1 ? 'claim' : null,
    }));
    const tx = previous.transaction([outboxStore, schema.V5_PROGRESS_STORE, schema.V5_SYNC_META_STORE], 'readwrite');
    for (const record of records) await tx.objectStore(outboxStore).put(record);
    await tx.objectStore(schema.V5_PROGRESS_STORE).put({ ownerKey: ownerA, bookId: 'book', cfi: 'saved' });
    await tx.objectStore(schema.V5_SYNC_META_STORE).put({ ownerKey: ownerA, targetKey: 'progress:book', nextSequence: 7 });
    await tx.done;
    previous.close();

    await assert.rejects(openDB(schema.LOCAL_DB_NAME, schema.LOCAL_DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, upgradeTx) {
        void upgradeTx.done.catch(() => undefined);
        schema.upgradeLocalDB(db, upgradeTx, oldVersion);
        upgradeTx.abort();
      },
    }));
    const rolledBack = await openDB(schema.LOCAL_DB_NAME, version);
    assert.equal(rolledBack.objectStoreNames.contains(outboxStore), true);
    assert.deepEqual(await rolledBack.getAll(outboxStore), records);
    rolledBack.close();

    const db = await initDB();
    assert.equal(db.objectStoreNames.contains(outboxStore), false);
    assert.deepEqual(await db.getAll(schema.V5_OUTBOX_STORE), records);
    assert.equal((await db.get(schema.V5_PROGRESS_STORE, [ownerA, 'book'])).cfi, 'saved');
    assert.equal((await db.get(schema.V5_SYNC_META_STORE, [ownerA, 'progress:book'])).nextSequence, 7);
    assert.deepEqual(Array.from(db.transaction(schema.V5_OUTBOX_STORE).store.indexNames), [
      'by-owner-status', 'by-owner-status-next-attempt', 'by-owner-target-sequence',
    ]);
    await assert.rejects(openDB(schema.LOCAL_DB_NAME, version), { name: 'VersionError' });
  });
}
