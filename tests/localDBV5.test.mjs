import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';

const {
  closeLocalDB,
  initDB,
  LocalStorageCapacityError,
} = await import('../src/lib/localDB.ts');
const {
  deleteOwnerLocalDataV5,
  getAllLocalProgressV5,
  getAllOfflineBooksV5,
  getMigrationMetaV5,
  getOwnerBindingsV5,
  getOwnerSessionV5,
  loadBookFromLocalV5,
  putOwnerBindingV5,
  putOwnerSessionV5,
  saveArchiveInspectionToLocalV5,
  saveBookToLocalV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const {
  inspectLegacyInventory,
  inspectOwnerInventoryV5,
  migrateLegacyDataToOwnerV5,
} = await import('../src/lib/localDBMigration.ts');
const schema = await import('../src/lib/localDBSchema.ts');
const {
  makeDriveScopeKey,
  makeFirebaseOwnerKey,
  makeOwnerKey,
} = await import('../src/lib/ownerIdentity.ts');

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('alice'), 'library:local');
const ownerB = makeOwnerKey(
  makeFirebaseOwnerKey('bob'),
  makeDriveScopeKey('drive-account-b'),
);

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

test('v4 upgrade preserves legacy data and creates the complete v5 schema', async () => {
  await seedLegacyV4();
  const db = await initDB();

  assert.equal(db.version, 5);
  for (const storeName of [
    schema.LEGACY_BOOKS_STORE,
    schema.LEGACY_METADATA_STORE,
    schema.LEGACY_PROGRESS_STORE,
    schema.LEGACY_ARCHIVE_INSPECTIONS_STORE,
    schema.V5_BOOKS_STORE,
    schema.V5_METADATA_STORE,
    schema.V5_PROGRESS_STORE,
    schema.V5_ARCHIVE_INSPECTIONS_STORE,
    schema.V5_OUTBOX_STORE,
    schema.V5_REMOTE_HEADS_STORE,
    schema.V5_SYNC_META_STORE,
    schema.V5_SYNC_CONFLICTS_STORE,
    schema.V5_SYNC_LEASES_STORE,
    schema.V5_OWNER_BINDINGS_STORE,
    schema.V5_OWNER_SESSION_STORE,
    schema.V5_MIGRATION_META_STORE,
  ]) {
    assert.equal(db.objectStoreNames.contains(storeName), true, storeName);
  }
  assert.equal((await db.get(schema.LEGACY_METADATA_STORE, 'same-id')).name, 'Alpha');
  assert.equal(
    db.transaction(schema.V5_OWNER_BINDINGS_STORE).store.indexNames.contains('by-auth-owner'),
    true,
  );
});

test('owner-scoped CRUD isolates identical book ids and owner deletion', async () => {
  await saveBookToLocalV5(ownerA, makeBook('same-id', 'A'), new Blob(['owner-a']));
  await saveBookToLocalV5(ownerB, makeBook('same-id', 'B'), new Blob(['owner-b']));
  await saveProgressToLocalV5(ownerA, {
    bookId: 'same-id', cfi: 'a', progressPercent: 10, lastRead: 1,
  });
  await saveProgressToLocalV5(ownerB, {
    bookId: 'same-id', cfi: 'b', progressPercent: 90, lastRead: 2,
  });
  await saveArchiveInspectionToLocalV5(ownerA, 'same-id', 'a', { entries: [] });
  await saveArchiveInspectionToLocalV5(ownerB, 'same-id', 'b', { entries: [] });

  assert.equal(await (await loadBookFromLocalV5(ownerA, 'same-id')).text(), 'owner-a');
  assert.equal(await (await loadBookFromLocalV5(ownerB, 'same-id')).text(), 'owner-b');
  assert.deepEqual((await getAllOfflineBooksV5(ownerA)).map(({ name }) => name), ['A']);
  assert.deepEqual((await getAllLocalProgressV5(ownerB)).map(({ cfi }) => cfi), ['b']);

  await deleteOwnerLocalDataV5(ownerA);
  assert.equal(await loadBookFromLocalV5(ownerA, 'same-id'), undefined);
  assert.equal(await (await loadBookFromLocalV5(ownerB, 'same-id')).text(), 'owner-b');
  assert.equal((await getAllOfflineBooksV5(ownerB)).length, 1);
  assert.equal((await getAllLocalProgressV5(ownerB)).length, 1);
});

test('owner bindings and last session are partitioned by authenticated owner', async () => {
  const authA = makeFirebaseOwnerKey('alice');
  const authB = makeFirebaseOwnerKey('bob');
  await putOwnerBindingV5({
    authOwnerKey: authA,
    libraryScopeKey: 'library:local',
    verifiedAt: 1,
  });
  await putOwnerBindingV5({
    authOwnerKey: authB,
    libraryScopeKey: makeDriveScopeKey('drive-account-b'),
    verifiedAt: 2,
  });
  await putOwnerSessionV5({ authOwnerKey: authA, ownerKey: ownerA, updatedAt: 3 });

  assert.deepEqual((await getOwnerBindingsV5(authA)).map(({ authOwnerKey }) => authOwnerKey), [authA]);
  assert.equal((await getOwnerSessionV5(authA)).ownerKey, ownerA);
  assert.equal(await getOwnerSessionV5(authB), undefined);
});

test('migration copies and verifies every legacy store without changing v4', async () => {
  await seedLegacyV4();
  const sourceBefore = await inspectLegacyInventory();
  const result = await migrateLegacyDataToOwnerV5(ownerA, {
    leaseHolder: 'tab-a',
    batchSize: 1,
  });
  const sourceAfter = await inspectLegacyInventory();
  const copied = await inspectOwnerInventoryV5(ownerA);

  assert.equal(result.status, 'completed');
  assert.deepEqual(sourceAfter, sourceBefore);
  assert.deepEqual(copied, sourceBefore);
  assert.equal((await getAllOfflineBooksV5(ownerA)).length, 2);
  assert.equal((await getAllOfflineBooksV5(ownerB)).length, 0);

  const repeated = await migrateLegacyDataToOwnerV5(ownerA, {
    leaseHolder: 'tab-b',
  });
  assert.equal(repeated.status, 'completed');
  assert.deepEqual(await inspectOwnerInventoryV5(ownerA), copied);
});

test('failed batch rolls back and a retry resumes idempotently', async () => {
  await seedLegacyV4();
  let injected = false;
  await assert.rejects(
    migrateLegacyDataToOwnerV5(ownerA, {
      leaseHolder: 'tab-a',
      batchSize: 1,
      beforeBatchCommit(store, count) {
        if (!injected && store === schema.LEGACY_BOOKS_STORE && count === 1) {
          injected = true;
          throw new DOMException('quota', 'QuotaExceededError');
        }
      },
    }),
    LocalStorageCapacityError,
  );

  const failed = await getMigrationMetaV5(`v4-to-v5:${ownerA}`);
  assert.equal(failed.status, 'failed');
  assert.equal((await inspectOwnerInventoryV5(ownerA)).counts.books, 0);
  assert.equal((await inspectLegacyInventory()).counts.books, 2);

  const retried = await migrateLegacyDataToOwnerV5(ownerA, {
    leaseHolder: 'tab-b',
    batchSize: 1,
  });
  assert.equal(retried.status, 'completed');
  assert.deepEqual(await inspectOwnerInventoryV5(ownerA), await inspectLegacyInventory());
});
