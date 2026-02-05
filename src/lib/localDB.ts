// src/lib/localDB.ts
import { openDB } from 'idb';
import { Book, UserProgress } from '../types';

const DB_NAME = 'web-reader-db';
const STORE_NAME = 'books';         // 책 내용(ArrayBuffer)
const META_STORE = 'metadata';      // 책 정보(Book + size)
const PROGRESS_STORE = 'progress';  // [New] 독서 진행 상황

export const initDB = async () => {
  return openDB(DB_NAME, 2, { // [Modified] 버전 1 -> 2로 증가
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      // [New] 진행 상황 저장소 추가
      if (!db.objectStoreNames.contains(PROGRESS_STORE)) {
        db.createObjectStore(PROGRESS_STORE, { keyPath: 'bookId' });
      }
    },
  });
};

// --- Book Management ---

export const saveBookToLocal = async (book: Book, content: ArrayBuffer) => {
  const db = await initDB();
  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  
  const metaData = { ...book, size: content.byteLength };

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

// --- Progress Management [New] ---

export const saveProgressToLocal = async (progress: UserProgress) => {
  const db = await initDB();
  // Firestore Timestamp 등을 저장하기 위해 직렬화가 필요할 수 있으나, 
  // IDB는 구조화된 복제 알고리즘을 사용하므로 Date 객체나 일반 객체 저장 가능.
  // 단, 타임스탬프 비교를 위해 lastRead를 숫자로 변환하거나 Date로 통일하는 것이 좋음.
  await db.put(PROGRESS_STORE, progress);
};

export const getProgressFromLocal = async (bookId: string): Promise<UserProgress | undefined> => {
  const db = await initDB();
  return db.get(PROGRESS_STORE, bookId);
};

export const getAllLocalProgress = async (): Promise<UserProgress[]> => {
  const db = await initDB();
  return db.getAll(PROGRESS_STORE);
};