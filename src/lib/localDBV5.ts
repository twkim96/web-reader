import { Book, UserProgress } from '../types';
import type { IDBPTransaction } from 'idb';
import type { StoredBookContent } from './bookContent';
import { initDB, LocalStorageCapacityError } from './localDB';
import {
  V5_ARCHIVE_INSPECTIONS_STORE,
  V5_BOOKS_STORE,
  V5_METADATA_STORE,
  V5_MIGRATION_META_STORE,
  V5_OWNER_BINDINGS_STORE,
  V5_OWNER_SESSION_STORE,
  V5_PROGRESS_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_LEASES_STORE,
  V5_SYNC_META_STORE,
  V5_OUTBOX_STORE,
} from './localDBSchema';
import type { ArchiveImageIndex } from './archiveImageBook';
import type {
  AuthOwnerKey,
  LibraryScopeKey,
  OwnerKey,
} from './ownerIdentity';
import { hasEnoughStorageForWrite } from './storageCapacity';

export type StoredBookMetadataV5 = Book & {
  ownerKey: OwnerKey;
  cachedSize?: number;
};

export type StoredProgressV5 = UserProgress & { ownerKey: OwnerKey };

export type OwnerBindingV5 = {
  authOwnerKey: AuthOwnerKey;
  libraryScopeKey: LibraryScopeKey;
  permissionId?: string;
  folderId?: string;
  verifiedAt: number;
};

export type OwnerSessionV5 = {
  authOwnerKey: AuthOwnerKey;
  ownerKey: OwnerKey;
  updatedAt: number;
};

export type MigrationStatusV5 =
  | 'pending_owner_confirmation'
  | 'copying'
  | 'verifying'
  | 'completed'
  | 'declined_empty'
  | 'legacy_read_only'
  | 'failed';

export type MigrationMetaV5 = {
  migrationId: string;
  ownerKey: OwnerKey;
  status: MigrationStatusV5;
  sourceCounts: Record<string, number>;
  copiedCounts: Record<string, number>;
  sourceContentBytes: number;
  copiedContentBytes: number;
  sourceKeyDigest?: string;
  copiedKeyDigest?: string;
  lastStore?: string;
  lastKey?: IDBValidKey;
  errorName?: string;
  errorMessage?: string;
  startedAt: number;
  completedAt?: number;
  leaseHolder?: string;
  leaseEpoch?: number;
  leaseExpiresAt?: number;
};

const getContentSize = (content: StoredBookContent) =>
  content instanceof Blob ? content.size : content.byteLength;

const isQuotaExceededError = (error: unknown) => (
  error instanceof DOMException && error.name === 'QuotaExceededError'
  || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'QuotaExceededError'
  )
);

const ensureCapacity = async (additionalBytes: number) => {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && !hasEnoughStorageForWrite(estimate, additionalBytes)) {
      throw new LocalStorageCapacityError();
    }
  } catch (error) {
    if (error instanceof LocalStorageCapacityError) throw error;
    console.warn('[StorageV5] Capacity estimate unavailable:', error);
  }
};

export const saveBookToLocalV5 = async (
  ownerKey: OwnerKey,
  book: Book,
  content: StoredBookContent,
) => {
  const db = await initDB();
  const size = getContentSize(content);
  const existing = await db.get(V5_METADATA_STORE, [ownerKey, book.id]) as
    StoredBookMetadataV5 | undefined;
  const existingSize = existing?.cachedSize ?? 0;
  await ensureCapacity(Math.max(0, size - existingSize));

  const tx = db.transaction([V5_BOOKS_STORE, V5_METADATA_STORE], 'readwrite');
  try {
    await tx.objectStore(V5_BOOKS_STORE).put(content, [ownerKey, book.id]);
    await tx.objectStore(V5_METADATA_STORE).put({
      ...book,
      ownerKey,
      size: book.size ?? size,
      cachedSize: size,
    });
    await tx.done;
  } catch (error) {
    if (isQuotaExceededError(error)) throw new LocalStorageCapacityError();
    throw error;
  }
};

export const loadBookFromLocalV5 = async (ownerKey: OwnerKey, bookId: string) => {
  const db = await initDB();
  return db.get(V5_BOOKS_STORE, [ownerKey, bookId]) as Promise<StoredBookContent | undefined>;
};

export const loadBookMetadataFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  return db.get(V5_METADATA_STORE, [ownerKey, bookId]) as
    Promise<StoredBookMetadataV5 | undefined>;
};

export const saveBookMetadataToLocalV5 = async (
  ownerKey: OwnerKey,
  book: Book,
  content: StoredBookContent,
) => {
  const db = await initDB();
  const size = getContentSize(content);
  await db.put(V5_METADATA_STORE, {
    ...book,
    ownerKey,
    size: book.size ?? size,
    cachedSize: size,
  });
};

export const getOfflineBookIdsV5 = async (ownerKey: OwnerKey) => {
  const books = await getAllOfflineBooksV5(ownerKey);
  return new Set(books.map(({ id }) => id));
};

export const getAllOfflineBooksV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  return db.getAllFromIndex(V5_METADATA_STORE, 'by-owner', ownerKey) as
    Promise<StoredBookMetadataV5[]>;
};

export const saveProgressToLocalV5 = async (
  ownerKey: OwnerKey,
  progress: UserProgress,
) => {
  const db = await initDB();
  await db.put(V5_PROGRESS_STORE, { ...progress, ownerKey });
};

export const getAllLocalProgressV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  return db.getAllFromIndex(V5_PROGRESS_STORE, 'by-owner', ownerKey) as
    Promise<StoredProgressV5[]>;
};

export const removeProgressFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  await db.delete(V5_PROGRESS_STORE, [ownerKey, bookId]);
};

export const saveArchiveInspectionToLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  fingerprint: string,
  index: ArchiveImageIndex,
) => {
  const db = await initDB();
  await db.put(V5_ARCHIVE_INSPECTIONS_STORE, {
    ownerKey, bookId, fingerprint, index,
  });
};

export const loadArchiveInspectionFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  fingerprint: string,
) => {
  const db = await initDB();
  const record = await db.get(V5_ARCHIVE_INSPECTIONS_STORE, [ownerKey, bookId]) as
    { fingerprint?: string; index?: ArchiveImageIndex } | undefined;
  return record?.fingerprint === fingerprint ? record.index : undefined;
};

export const removeBookFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_BOOKS_STORE,
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
  ], 'readwrite');
  await Promise.all([
    tx.objectStore(V5_BOOKS_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_METADATA_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_PROGRESS_STORE).delete([ownerKey, bookId]),
    tx.objectStore(V5_ARCHIVE_INSPECTIONS_STORE).delete([ownerKey, bookId]),
  ]);
  await tx.done;
};

const deleteByOwnerIndex = async (
  transaction: IDBPTransaction<unknown, [string], 'readwrite'>,
  storeName: string,
  ownerKey: OwnerKey,
) => {
  const store = transaction.objectStore(storeName);
  if (!store.indexNames.contains('by-owner')) return;
  const keys = await store.index('by-owner').getAllKeys(ownerKey);
  await Promise.all(keys.map((key) => store.delete(key)));
};

const deleteByCompoundOwnerKey = async (
  transaction: IDBPTransaction<unknown, [string], 'readwrite'>,
  storeName: string,
  ownerKey: string,
) => {
  const store = transaction.objectStore(storeName);
  const keys = await store.getAllKeys();
  await Promise.all(keys
    .filter((key) => Array.isArray(key) && key[0] === ownerKey)
    .map((key) => store.delete(key)));
};

export const deleteOwnerLocalDataV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const indexedStores = [
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ];
  for (const storeName of indexedStores) {
    const tx = db.transaction(storeName, 'readwrite');
    await deleteByOwnerIndex(tx, storeName, ownerKey);
    await tx.done;
  }
  for (const storeName of [
    V5_BOOKS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ]) {
    const tx = db.transaction(storeName, 'readwrite');
    await deleteByCompoundOwnerKey(tx, storeName, ownerKey);
    await tx.done;
  }
  const tx = db.transaction(V5_SYNC_LEASES_STORE, 'readwrite');
  await tx.objectStore(V5_SYNC_LEASES_STORE).delete(ownerKey);
  await tx.done;
};

export const putOwnerBindingV5 = async (binding: OwnerBindingV5) => {
  const db = await initDB();
  await db.put(V5_OWNER_BINDINGS_STORE, binding);
};

export const getOwnerBindingsV5 = async (authOwnerKey: AuthOwnerKey) => {
  const db = await initDB();
  return db.getAllFromIndex(
    V5_OWNER_BINDINGS_STORE,
    'by-auth-owner',
    authOwnerKey,
  ) as Promise<OwnerBindingV5[]>;
};

export const putOwnerSessionV5 = async (session: OwnerSessionV5) => {
  const db = await initDB();
  await db.put(V5_OWNER_SESSION_STORE, session);
};

export const getOwnerSessionV5 = async (authOwnerKey: AuthOwnerKey) => {
  const db = await initDB();
  return db.get(V5_OWNER_SESSION_STORE, authOwnerKey) as Promise<OwnerSessionV5 | undefined>;
};

export const putMigrationMetaV5 = async (meta: MigrationMetaV5) => {
  const db = await initDB();
  await db.put(V5_MIGRATION_META_STORE, meta);
};

export const getMigrationMetaV5 = async (migrationId: string) => {
  const db = await initDB();
  return db.get(V5_MIGRATION_META_STORE, migrationId) as
    Promise<MigrationMetaV5 | undefined>;
};
