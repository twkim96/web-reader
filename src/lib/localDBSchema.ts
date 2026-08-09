import type { IDBPDatabase, IDBPTransaction } from 'idb';

export const LOCAL_DB_NAME = 'web-reader-db';
export const LOCAL_DB_VERSION = 12;

export const LEGACY_BOOKS_STORE = 'books';
export const LEGACY_METADATA_STORE = 'metadata';
export const LEGACY_PROGRESS_STORE = 'progress';
export const LEGACY_ARCHIVE_INSPECTIONS_STORE = 'archive-inspections';

export const V5_BOOKS_STORE = 'books-v5';
export const V5_METADATA_STORE = 'metadata-v5';
export const V5_PROGRESS_STORE = 'progress-v5';
export const V5_ARCHIVE_INSPECTIONS_STORE = 'archive-inspections-v5';
export const V5_OUTBOX_STORE = 'outbox-v5';
export const V5_REMOTE_HEADS_STORE = 'remote-heads-v5';
export const V5_SYNC_META_STORE = 'sync-meta-v5';
export const V5_SYNC_CONFLICTS_STORE = 'sync-conflicts-v5';
export const V5_SYNC_LEASES_STORE = 'sync-leases-v5';
export const V8_ANNOTATIONS_STORE = 'annotations-v8';
export const V9_ANNOTATION_SETTINGS_STORE = 'annotation-settings-v9';
export const V10_ANNOTATION_BOOK_DELETIONS_STORE = 'annotation-book-deletions-v10';
export const V11_READING_SESSIONS_STORE = 'reading-sessions-v11';
export const V12_READING_STATISTICS_SYNC_STORE = 'reading-statistics-sync-v12';

const createStore = (
  db: IDBPDatabase<unknown>,
  name: string,
  options?: IDBObjectStoreParameters,
) => db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, options);

type UpgradeStore = {
  readonly indexNames: { contains(name: string): boolean };
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: IDBIndexParameters,
  ): unknown;
};

const createIndex = (
  store: UpgradeStore | null,
  name: string,
  keyPath: string | string[],
  options?: IDBIndexParameters,
) => {
  if (store && !store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
};

export const upgradeLocalDB = (
  db: IDBPDatabase<unknown>,
  transaction: IDBPTransaction<unknown, string[], 'versionchange'>,
  oldVersion: number,
) => {
  for (const obsoleteStore of [
    LEGACY_BOOKS_STORE,
    LEGACY_METADATA_STORE,
    LEGACY_PROGRESS_STORE,
    LEGACY_ARCHIVE_INSPECTIONS_STORE,
    'owner-bindings-v5',
    'owner-session-v5',
    'migration-meta-v5',
  ]) {
    if (db.objectStoreNames.contains(obsoleteStore)) db.deleteObjectStore(obsoleteStore);
  }

  // Version 5 content records were partitioned by account. Version 6 changed
  // them to one device-global cache, so only that exact legacy transition may
  // discard the incompatible content stores. Version 6+ stores are active user
  // data and must survive index-only and all future schema upgrades.
  if (oldVersion > 0 && oldVersion < 6) {
    for (const incompatibleStore of [
      V5_BOOKS_STORE,
      V5_METADATA_STORE,
      V5_ARCHIVE_INSPECTIONS_STORE,
    ]) {
      if (db.objectStoreNames.contains(incompatibleStore)) {
        db.deleteObjectStore(incompatibleStore);
      }
    }
  }

  createStore(db, V5_BOOKS_STORE);

  const metadata = createStore(db, V5_METADATA_STORE, {
    keyPath: ['ownerKey', 'id'],
  }) ?? transaction.objectStore(V5_METADATA_STORE);
  createIndex(metadata, 'by-owner', 'ownerKey');

  const progress = createStore(db, V5_PROGRESS_STORE, {
    keyPath: ['ownerKey', 'bookId'],
  }) ?? transaction.objectStore(V5_PROGRESS_STORE);
  createIndex(progress, 'by-owner', 'ownerKey');

  const inspections = createStore(db, V5_ARCHIVE_INSPECTIONS_STORE, {
    keyPath: ['ownerKey', 'bookId'],
  }) ?? transaction.objectStore(V5_ARCHIVE_INSPECTIONS_STORE);
  createIndex(inspections, 'by-owner', 'ownerKey');

  const outbox = createStore(db, V5_OUTBOX_STORE, {
    keyPath: ['ownerKey', 'eventId'],
  }) ?? transaction.objectStore(V5_OUTBOX_STORE);
  createIndex(outbox, 'by-owner-status-next-attempt', [
    'ownerKey', 'status', 'nextAttemptAt',
  ]);
  createIndex(outbox, 'by-owner-status', ['ownerKey', 'status']);
  createIndex(outbox, 'by-owner-target-sequence', [
    'ownerKey', 'targetKey', 'sequence',
  ]);

  const remoteHeads = createStore(db, V5_REMOTE_HEADS_STORE, {
    keyPath: ['ownerKey', 'targetKey'],
  }) ?? transaction.objectStore(V5_REMOTE_HEADS_STORE);
  createIndex(remoteHeads, 'by-owner', 'ownerKey');

  const syncMeta = createStore(db, V5_SYNC_META_STORE, {
    keyPath: ['ownerKey', 'targetKey'],
  }) ?? transaction.objectStore(V5_SYNC_META_STORE);
  createIndex(syncMeta, 'by-owner', 'ownerKey');

  const conflicts = createStore(db, V5_SYNC_CONFLICTS_STORE, {
    keyPath: ['ownerKey', 'conflictId'],
  }) ?? transaction.objectStore(V5_SYNC_CONFLICTS_STORE);
  createIndex(conflicts, 'by-owner-target-state', [
    'ownerKey', 'targetKey', 'state',
  ]);
  createIndex(conflicts, 'by-owner-state-created-at', [
    'ownerKey', 'state', 'createdAt',
  ]);

  createStore(db, V5_SYNC_LEASES_STORE, { keyPath: 'ownerKey' });

  const annotations = createStore(db, V8_ANNOTATIONS_STORE, {
    keyPath: ['ownerKey', 'bookId', 'id'],
  }) ?? transaction.objectStore(V8_ANNOTATIONS_STORE);
  createIndex(annotations, 'by-owner', 'ownerKey');
  createIndex(annotations, 'by-owner-book', ['ownerKey', 'bookId']);
  createIndex(annotations, 'by-owner-book-color', ['ownerKey', 'bookId', 'colorId']);
  createIndex(
    annotations,
    'by-owner-book-range',
    ['ownerKey', 'bookId', 'rangeCfi'],
    { unique: true },
  );

  createStore(db, V9_ANNOTATION_SETTINGS_STORE, { keyPath: 'ownerKey' });

  const annotationBookDeletions = createStore(
    db,
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    { keyPath: ['ownerKey', 'bookId'] },
  ) ?? transaction.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE);
  createIndex(annotationBookDeletions, 'by-owner', 'ownerKey');

  const readingSessions = createStore(db, V11_READING_SESSIONS_STORE, {
    keyPath: ['ownerKey', 'sessionId'],
  }) ?? transaction.objectStore(V11_READING_SESSIONS_STORE);
  createIndex(readingSessions, 'by-owner', 'ownerKey');
  createIndex(readingSessions, 'by-owner-book', ['ownerKey', 'bookId']);
  createIndex(readingSessions, 'by-owner-started-at', ['ownerKey', 'startedAtClient']);
  createIndex(readingSessions, 'by-owner-sync-next-attempt', [
    'ownerKey', 'syncState', 'nextAttemptAt',
  ]);

  createStore(db, V12_READING_STATISTICS_SYNC_STORE, { keyPath: 'ownerKey' });
};
