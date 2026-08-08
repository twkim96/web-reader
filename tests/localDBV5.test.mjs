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
  removeBookAndAnnotationsV8,
  saveArchiveInspectionToLocalV5,
  saveBookToLocalV5,
  saveProgressToLocalV5,
} = await import('../src/lib/localDBV5.ts');
const {
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
} = await import('../src/lib/localAnnotations.ts');
const { getPendingLocalCommitCount } = await import('../src/lib/localCommitTracker.ts');
const { getOutboxEventsV5 } = await import('../src/lib/syncOutboxV5.ts');
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
      const outbox = database.createObjectStore(schema.V5_OUTBOX_STORE, {
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
  ], 'readwrite');
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
  assert.deepEqual(await getLocalAnnotationsV8(ownerA, 'same-id'), []);
  assert.equal((await getLocalAnnotationsV8(ownerA, 'other-id')).length, 1);
  assert.equal((await getLocalAnnotationsV8(ownerB, 'same-id')).length, 1);
});

test('atomically queues annotation tombstones with authenticated book deletion', async () => {
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
  assert.equal(events.length, 2);
  const annotationDelete = events.find(({ target }) => target.annotationId === 'owner-a');
  assert.equal(annotationDelete.operation, 'annotation.delete');
  assert.equal(annotationDelete.forceDelete, true);
  assert.ok(events.some(({ target }) => target.annotationId === 'book_delete_marker_v1'));
  const db = await initDB();
  assert.ok(await db.get(schema.V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerA, 'same-id']));
});

test('queues authoritative remote-only annotation tombstones during book deletion', async () => {
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
    ['remote-only'],
  );
  assert.deepEqual(result, { annotationsDeleted: 0, tombstonesQueued: 2 });
  const events = await getOutboxEventsV5(ownerA);
  assert.equal(events.length, 2);
  const remoteDelete = events.find(({ target }) => target.annotationId === 'remote-only');
  assert.equal(remoteDelete.operation, 'annotation.delete');
  assert.equal(remoteDelete.forceDelete, true);
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
