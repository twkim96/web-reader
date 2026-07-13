// src/lib/localDB.ts
import { openDB } from 'idb';
import {
  LOCAL_DB_NAME,
  LOCAL_DB_VERSION,
  upgradeLocalDB,
} from './localDBSchema';

let dbPromise: ReturnType<typeof openDB> | undefined;
let currentDB: Awaited<ReturnType<typeof openDB>> | undefined;

export type LocalDBLifecycleEvent =
  | { type: 'blocked'; currentVersion: number; targetVersion: number | null }
  | { type: 'blocking'; currentVersion: number; targetVersion: number | null }
  | { type: 'terminated' };

const lifecycleListeners = new Set<(event: LocalDBLifecycleEvent) => void>();

const emitLifecycle = (event: LocalDBLifecycleEvent) => {
  for (const listener of lifecycleListeners) listener(event);
};

export const subscribeLocalDBLifecycle = (
  listener: (event: LocalDBLifecycleEvent) => void,
) => {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
};

export class LocalStorageCapacityError extends Error {
  constructor() {
    super('기기 저장 공간이 부족해 도서를 오프라인으로 저장할 수 없습니다.');
    this.name = 'LocalStorageCapacityError';
  }
}

export const initDB = async () => {
  if (!dbPromise) {
    dbPromise = openDB(LOCAL_DB_NAME, LOCAL_DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        upgradeLocalDB(db, transaction, oldVersion);
      },
      blocked(currentVersion, targetVersion) {
        emitLifecycle({ type: 'blocked', currentVersion, targetVersion });
      },
      blocking(currentVersion, targetVersion) {
        emitLifecycle({ type: 'blocking', currentVersion, targetVersion });
        currentDB?.close();
        currentDB = undefined;
        dbPromise = undefined;
      },
      terminated() {
        emitLifecycle({ type: 'terminated' });
        currentDB = undefined;
        dbPromise = undefined;
      },
    }).then((db) => {
      currentDB = db;
      return db;
    }).catch((error) => {
      currentDB = undefined;
      dbPromise = undefined;
      throw error;
    });
  }
  return dbPromise;
};

export const closeLocalDB = async () => {
  const db = currentDB ?? (dbPromise ? await dbPromise.catch(() => undefined) : undefined);
  db?.close();
  currentDB = undefined;
  dbPromise = undefined;
};
