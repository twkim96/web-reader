import type { IDBPDatabase, IDBPTransaction } from 'idb';

export const LOCAL_DB_NAME = 'web-reader-db';
export const LOCAL_DB_VERSION = 5;

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
export const V5_OWNER_BINDINGS_STORE = 'owner-bindings-v5';
export const V5_OWNER_SESSION_STORE = 'owner-session-v5';
export const V5_MIGRATION_META_STORE = 'migration-meta-v5';

const createStore = (
  db: IDBPDatabase<unknown>,
  name: string,
  options?: IDBObjectStoreParameters,
) => db.objectStoreNames.contains(name) ? null : db.createObjectStore(name, options);

type UpgradeStore = {
  readonly indexNames: { contains(name: string): boolean };
  createIndex(name: string, keyPath: string | string[]): unknown;
};

const createIndex = (
  store: UpgradeStore | null,
  name: string,
  keyPath: string | string[],
) => {
  if (store && !store.indexNames.contains(name)) store.createIndex(name, keyPath);
};

export const upgradeLocalDB = (
  db: IDBPDatabase<unknown>,
  transaction: IDBPTransaction<unknown, string[], 'versionchange'>,
) => {
  createStore(db, LEGACY_BOOKS_STORE);
  createStore(db, LEGACY_METADATA_STORE, { keyPath: 'id' });
  createStore(db, LEGACY_PROGRESS_STORE, { keyPath: 'bookId' });
  createStore(db, LEGACY_ARCHIVE_INSPECTIONS_STORE, { keyPath: 'bookId' });

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

  createStore(db, V5_SYNC_LEASES_STORE, { keyPath: 'ownerKey' });
  const ownerBindings = createStore(db, V5_OWNER_BINDINGS_STORE, {
    keyPath: ['authOwnerKey', 'libraryScopeKey'],
  }) ?? transaction.objectStore(V5_OWNER_BINDINGS_STORE);
  createIndex(ownerBindings, 'by-auth-owner', 'authOwnerKey');
  createStore(db, V5_OWNER_SESSION_STORE, { keyPath: 'authOwnerKey' });

  const migrationMeta = createStore(db, V5_MIGRATION_META_STORE, {
    keyPath: 'migrationId',
  }) ?? transaction.objectStore(V5_MIGRATION_META_STORE);
  createIndex(migrationMeta, 'by-status', 'status');
};
