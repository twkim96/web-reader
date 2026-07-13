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
  deleteOwnerLocalDataV5,
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  loadBookFromLocalV5,
  saveArchiveInspectionToLocalV5,
  saveBookToLocalV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
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

test.beforeEach(deleteDatabase);
test.after(deleteDatabase);

test('v4 upgrade discards retired stores and creates the active schema', async () => {
  await seedLegacyV4();
  const db = await initDB();

  assert.equal(db.version, 6);
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

test('blocked v5 open is reported and resumes after the old connection closes', async () => {
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
  assert.equal(blockedEvent.targetVersion, 6);
  oldConnection.close();
  assert.equal((await opening).version, 6);
});
