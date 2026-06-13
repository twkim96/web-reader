// src/lib/localDB.ts
import { openDB } from 'idb';
import { Book, UserProgress } from '../types';
import type { StoredBookContent } from './bookContent';
import type { ArchiveImageIndex } from './archiveImageBook';
import { hasEnoughStorageForWrite } from './storageCapacity';

const DB_NAME = 'web-reader-db';
const STORE_NAME = 'books';         // 책 내용(ArrayBuffer 또는 Blob)
const META_STORE = 'metadata';      // 책 정보(Book + size)
const PROGRESS_STORE = 'progress';
const ARCHIVE_INSPECTION_STORE = 'archive-inspections';
let dbPromise: ReturnType<typeof openDB> | undefined;

type StoredBookMetadata = Book & {
  cachedSize?: number;
};

type ArchiveInspectionRecord = {
  bookId: string;
  fingerprint: string;
  index: ArchiveImageIndex;
};

export class LocalStorageCapacityError extends Error {
  constructor() {
    super('기기 저장 공간이 부족해 도서를 오프라인으로 저장할 수 없습니다.');
    this.name = 'LocalStorageCapacityError';
  }
}

const getContentSize = (content: StoredBookContent) => (
  content instanceof Blob ? content.size : content.byteLength
);

const isQuotaExceededError = (error: unknown) => (
  error instanceof DOMException && error.name === 'QuotaExceededError'
  || (
    typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'QuotaExceededError'
  )
);

export const initDB = async () => {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 4, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
          db.createObjectStore(PROGRESS_STORE, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(ARCHIVE_INSPECTION_STORE)) {
          db.createObjectStore(ARCHIVE_INSPECTION_STORE, { keyPath: 'bookId' });
        }
      },
    }).catch((error) => {
      dbPromise = undefined;
      throw error;
    });
  }
  return dbPromise;
};

// --- Book Management ---

export const saveBookToLocal = async (book: Book, content: StoredBookContent) => {
  const db = await initDB();
  const size = getContentSize(content);
  const existing = await db.get(META_STORE, book.id) as StoredBookMetadata | undefined;
  const existingSize = existing?.cachedSize
    ?? (typeof existing?.size === 'number' ? existing.size : 0);
  const additionalBytes = Math.max(0, size - existingSize);

  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && !hasEnoughStorageForWrite(estimate, additionalBytes)) {
      throw new LocalStorageCapacityError();
    }
  } catch (error) {
    if (error instanceof LocalStorageCapacityError) throw error;
    console.warn('[Storage] Capacity estimate unavailable:', error);
  }

  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  
  const metaData = {
    ...book,
    size: book.size ?? size,
    cachedSize: size,
  };

  try {
    await tx.objectStore(STORE_NAME).put(content, book.id);
    await tx.objectStore(META_STORE).put(metaData);
    await tx.done;
  } catch (error) {
    if (isQuotaExceededError(error)) throw new LocalStorageCapacityError();
    throw error;
  }
};

export const loadBookFromLocal = async (id: string) => {
  const db = await initDB();
  return db.get(STORE_NAME, id);
};

export const loadBookMetadataFromLocal = async (id: string) => {
  const db = await initDB();
  return db.get(META_STORE, id) as Promise<StoredBookMetadata | undefined>;
};

export const saveBookMetadataToLocal = async (
  book: Book,
  content: StoredBookContent,
) => {
  const db = await initDB();
  await db.put(META_STORE, {
    ...book,
    size: book.size ?? getContentSize(content),
    cachedSize: getContentSize(content),
  });
};

export const loadArchiveInspectionFromLocal = async (
  bookId: string,
  fingerprint: string,
) => {
  const db = await initDB();
  const record = await db.get(
    ARCHIVE_INSPECTION_STORE,
    bookId,
  ) as ArchiveInspectionRecord | undefined;
  return record?.fingerprint === fingerprint ? record.index : undefined;
};

export const saveArchiveInspectionToLocal = async (
  bookId: string,
  fingerprint: string,
  index: ArchiveImageIndex,
) => {
  const db = await initDB();
  await db.put(ARCHIVE_INSPECTION_STORE, { bookId, fingerprint, index });
};

export const removeBookFromLocal = async (id: string) => {
  const db = await initDB();
  const tx = db.transaction(
    [STORE_NAME, META_STORE, PROGRESS_STORE, ARCHIVE_INSPECTION_STORE],
    'readwrite',
  );
  
  await tx.objectStore(STORE_NAME).delete(id);
  await tx.objectStore(META_STORE).delete(id);
  await tx.objectStore(PROGRESS_STORE).delete(id);
  await tx.objectStore(ARCHIVE_INSPECTION_STORE).delete(id);
  
  await tx.done;
};

export const getOfflineBookIds = async () => {
  const db = await initDB();
  const keys = await db.getAllKeys(STORE_NAME);
  return new Set(keys.map(String));
};

export const getAllOfflineBooks = async (): Promise<(Book & { size?: number })[]> => {
  const db = await initDB();
  return db.getAll(META_STORE);
};

// --- Progress Management ---

export const saveProgressToLocal = async (progress: UserProgress) => {
  const db = await initDB();
  await db.put(PROGRESS_STORE, progress);
};

export const getAllLocalProgress = async (): Promise<UserProgress[]> => {
  const db = await initDB();
  return db.getAll(PROGRESS_STORE);
};
