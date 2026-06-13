// src/lib/localDB.ts
import { openDB } from 'idb';
import { Book, UserProgress } from '../types';
import type { StoredBookContent } from './bookContent';

const DB_NAME = 'web-reader-db';
const STORE_NAME = 'books';         // 책 내용(ArrayBuffer 또는 Blob)
const META_STORE = 'metadata';      // 책 정보(Book + size)
const PROGRESS_STORE = 'progress';

export const initDB = async () => {
  return openDB(DB_NAME, 3, {
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
    },
  });
};

// --- Book Management ---

export const saveBookToLocal = async (book: Book, content: StoredBookContent) => {
  const db = await initDB();
  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  
  const metaData = {
    ...book,
    size: content instanceof Blob ? content.size : content.byteLength,
  };

  await tx.objectStore(STORE_NAME).put(content, book.id);
  await tx.objectStore(META_STORE).put(metaData); 
  
  await tx.done;
};

export const loadBookFromLocal = async (id: string) => {
  const db = await initDB();
  return db.get(STORE_NAME, id);
};

export const removeBookFromLocal = async (id: string) => {
  const db = await initDB();
  const tx = db.transaction([STORE_NAME, META_STORE, PROGRESS_STORE], 'readwrite');
  
  await tx.objectStore(STORE_NAME).delete(id);
  await tx.objectStore(META_STORE).delete(id);
  await tx.objectStore(PROGRESS_STORE).delete(id); 
  
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
