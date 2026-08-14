import { Book, UserProgress } from '../types';
import type { IDBPTransaction } from 'idb';
import type { StoredBookContent } from './bookContent';
import { initDB, LocalStorageCapacityError } from './localDB';
import {
  V5_ARCHIVE_INSPECTIONS_STORE,
  V5_BOOKS_STORE,
  V5_METADATA_STORE,
  V5_PROGRESS_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_LEASES_STORE,
  V5_SYNC_META_STORE,
  V5_OUTBOX_STORE,
  V8_ANNOTATIONS_STORE,
  V9_ANNOTATION_SETTINGS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
  V11_READING_SESSIONS_STORE,
  V12_READING_STATISTICS_SYNC_STORE,
} from './localDBSchema';
import type { ArchiveImageIndex } from './archiveImageBook';
import type { OwnerKey } from './ownerIdentity';
import { hasEnoughStorageForWrite } from './storageCapacity';
import { trackLocalCommit } from './localCommitTracker';
import {
  ANNOTATION_BOOK_DELETE_MARKER_ID,
  isAnnotation,
} from './annotationPolicy';
import { isAnnotationHeadV1 } from './annotationSyncSchema';
import {
  appendAnnotationEventsToTransactionV5,
  type AnnotationSyncContextV5,
} from './syncOutboxV5';
import { notifyProgressSyncWork } from './progressSyncWake';
import { broadcastAnnotationSyncChange } from './annotationSyncWake';
import type { AnnotationBookDeletionIntentV10 } from './annotationBookDeletion';

export type StoredBookMetadataV5 = Book & {
  ownerKey: OwnerKey;
  cachedSize?: number;
};

export type StoredProgressV5 = UserProgress & { ownerKey: OwnerKey };


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

export const loadProgressFromLocalV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
): Promise<UserProgress | undefined> => {
  const db = await initDB();
  const stored = await db.get(V5_PROGRESS_STORE, [ownerKey, bookId]) as StoredProgressV5 | undefined;
  if (!stored) return undefined;
  return {
    bookId: stored.bookId,
    cfi: stored.cfi,
    anchorCfi: stored.anchorCfi,
    progressPercent: stored.progressPercent,
    lastRead: stored.lastRead,
    bookmarks: stored.bookmarks,
    syncRevision: stored.syncRevision,
    acceptedEventId: stored.acceptedEventId,
    ignoredRemoteRevision: stored.ignoredRemoteRevision,
  };
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

export const removeBookAndAnnotationsV8 = (
  annotationOwnerKey: OwnerKey,
  contentOwnerKey: OwnerKey,
  bookId: string,
  syncContext?: AnnotationSyncContextV5,
  authoritativeAnnotationIds: ReadonlyArray<string> = [],
) => trackLocalCommit((async () => {
  const db = await initDB();
  const tx = db.transaction([
    V5_BOOKS_STORE,
    V5_METADATA_STORE,
    V5_PROGRESS_STORE,
    V5_ARCHIVE_INSPECTIONS_STORE,
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  try {
    const deletionAt = Date.now();
    const annotationStore = tx.objectStore(V8_ANNOTATIONS_STORE);
    const [annotationKeys, annotationRecords] = await Promise.all([
      annotationStore.index('by-owner-book').getAllKeys([
        annotationOwnerKey,
        bookId,
      ]),
      annotationStore.index('by-owner-book').getAll([
        annotationOwnerKey,
        bookId,
      ]),
    ]);
    const validAnnotations = annotationRecords.filter(isAnnotation);
    const cachedHeads = await tx.objectStore(V5_REMOTE_HEADS_STORE)
      .index('by-owner')
      .getAll(annotationOwnerKey) as Array<{ head?: unknown }>;
    const cachedAnnotationHeads = new Map(cachedHeads.flatMap(({ head }) => (
      isAnnotationHeadV1(head) && head.bookId === bookId
        ? [[head.annotationId, head] as const]
        : []
    )));
    const annotationIds = new Set([
      ...(syncContext ? [ANNOTATION_BOOK_DELETE_MARKER_ID] : []),
      ...validAnnotations.map(({ id }) => id),
      ...authoritativeAnnotationIds,
      ...cachedAnnotationHeads.keys(),
    ].filter(Boolean));
    await Promise.all([
      ...annotationKeys.map((key) => annotationStore.delete(key)),
      tx.objectStore(V5_BOOKS_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_METADATA_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_PROGRESS_STORE).delete([contentOwnerKey, bookId]),
      tx.objectStore(V5_ARCHIVE_INSPECTIONS_STORE).delete([contentOwnerKey, bookId]),
    ]);
    const events = syncContext
      ? await appendAnnotationEventsToTransactionV5(
        tx,
        annotationOwnerKey,
        [...annotationIds].map((annotationId, index) => ({
          bookId,
          annotationId,
          operation: 'annotation.delete' as const,
          payload: null,
          baseRevision: cachedAnnotationHeads.get(annotationId)?.revision,
          forceDelete: true,
          occurredAtClient: deletionAt + index,
        })),
        syncContext,
      )
      : [];
    if (syncContext) {
      await tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).put({
        ownerKey: annotationOwnerKey,
        bookId,
        createdAt: deletionAt,
        lastCheckedAt: null,
        failureCount: 0,
        lastErrorCode: null,
        nextRetryAt: 0,
      } satisfies AnnotationBookDeletionIntentV10);
    }
    await tx.done;
    if (events.length > 0 || syncContext) notifyProgressSyncWork(annotationOwnerKey);
    if (annotationIds.size > 0) {
      broadcastAnnotationSyncChange({ ownerKey: annotationOwnerKey, bookId });
    }
    return {
      annotationsDeleted: annotationKeys.length,
      tombstonesQueued: events.length,
    };
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    try {
      await tx.done;
    } catch {
      // Preserve the original operation error below.
    }
    throw error;
  }
})());

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
    V8_ANNOTATIONS_STORE,
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    V11_READING_SESSIONS_STORE,
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
  const settingsTx = db.transaction(V9_ANNOTATION_SETTINGS_STORE, 'readwrite');
  await settingsTx.objectStore(V9_ANNOTATION_SETTINGS_STORE).delete(ownerKey);
  await settingsTx.done;
  const statisticsSyncTx = db.transaction(V12_READING_STATISTICS_SYNC_STORE, 'readwrite');
  await statisticsSyncTx.objectStore(V12_READING_STATISTICS_SYNC_STORE).delete(ownerKey);
  await statisticsSyncTx.done;
};
