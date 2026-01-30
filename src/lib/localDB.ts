// src/lib/localDB.ts
import { openDB } from 'idb';
import { Book } from '../types';

const DB_NAME = 'web-reader-db';
const STORE_NAME = 'books';         // 책 내용(ArrayBuffer)
const META_STORE = 'metadata';      // 책 정보(Book + size)

export const initDB = async () => {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
    },
  });
};

// [Modified] 파일 크기(size)를 메타데이터에 함께 저장
export const saveBookToLocal = async (book: Book, content: ArrayBuffer) => {
  const db = await initDB();
  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  
  // Book 타입에 size 속성이 없더라도 DB에는 저장 가능 (JS 객체 특성 활용)
  const metaData = { ...book, size: content.byteLength };

  await tx.objectStore(STORE_NAME).put(content, book.id);
  await tx.objectStore(META_STORE).put(metaData); 
  
  await tx.done;
};

export const loadBookFromLocal = async (id: string) => {
  const db = await initDB();
  return db.get(STORE_NAME, id);
};

// [Modified] 함수명 변경됨 (removeOfflineBook -> removeBookFromLocal)
export const removeBookFromLocal = async (id: string) => {
  const db = await initDB();
  const tx = db.transaction([STORE_NAME, META_STORE], 'readwrite');
  
  await tx.objectStore(STORE_NAME).delete(id);
  await tx.objectStore(META_STORE).delete(id);
  
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