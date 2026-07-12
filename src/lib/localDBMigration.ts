import type { IDBPDatabase } from 'idb';
import type { StoredBookContent } from './bookContent';
import { initDB, LocalStorageCapacityError } from './localDB';
import {
  LEGACY_ARCHIVE_INSPECTIONS_STORE,
  LEGACY_BOOKS_STORE,
  LEGACY_METADATA_STORE,
  LEGACY_PROGRESS_STORE,
  V5_ARCHIVE_INSPECTIONS_STORE,
  V5_BOOKS_STORE,
  V5_METADATA_STORE,
  V5_MIGRATION_META_STORE,
  V5_PROGRESS_STORE,
} from './localDBSchema';
import type { MigrationMetaV5 } from './localDBV5';
import type { OwnerKey } from './ownerIdentity';

const SOURCE_STORES = [
  LEGACY_BOOKS_STORE,
  LEGACY_METADATA_STORE,
  LEGACY_PROGRESS_STORE,
  LEGACY_ARCHIVE_INSPECTIONS_STORE,
] as const;

type SourceStore = typeof SOURCE_STORES[number];

const TARGET_BY_SOURCE: Record<SourceStore, string> = {
  [LEGACY_BOOKS_STORE]: V5_BOOKS_STORE,
  [LEGACY_METADATA_STORE]: V5_METADATA_STORE,
  [LEGACY_PROGRESS_STORE]: V5_PROGRESS_STORE,
  [LEGACY_ARCHIVE_INSPECTIONS_STORE]: V5_ARCHIVE_INSPECTIONS_STORE,
};

export type LegacyInventory = {
  counts: Record<SourceStore, number>;
  contentBytes: number;
  keyDigest: string;
};

export type MigrationOptions = {
  batchSize?: number;
  leaseHolder: string;
  leaseDurationMs?: number;
  now?: () => number;
  beforeBatchCommit?: (store: SourceStore, copiedCount: number) => void;
  onBatchCommitted?: (store: SourceStore, copiedCount: number) => void | Promise<void>;
};

export class MigrationLeaseUnavailableError extends Error {
  constructor() {
    super('다른 탭에서 로컬 데이터 이전을 진행하고 있습니다.');
    this.name = 'MigrationLeaseUnavailableError';
  }
}

export const migrationIdFor = (ownerKey: OwnerKey) => `v4-to-v5:${ownerKey}`;

export const recordLegacyMigrationDecision = async (
  ownerKey: OwnerKey,
  status: 'declined_empty' | 'legacy_read_only',
) => {
  const db = await initDB();
  const source = await inspectLegacyInventory(db);
  const existing = await db.get(
    V5_MIGRATION_META_STORE,
    migrationIdFor(ownerKey),
  ) as MigrationMetaV5 | undefined;
  const record: MigrationMetaV5 = {
    migrationId: migrationIdFor(ownerKey),
    ownerKey,
    status,
    sourceCounts: source.counts,
    copiedCounts: existing?.copiedCounts ?? {},
    sourceContentBytes: source.contentBytes,
    copiedContentBytes: existing?.copiedContentBytes ?? 0,
    sourceKeyDigest: source.keyDigest,
    copiedKeyDigest: existing?.copiedKeyDigest,
    startedAt: existing?.startedAt ?? Date.now(),
    completedAt: Date.now(),
  };
  await db.put(V5_MIGRATION_META_STORE, record);
  return record;
};

const contentSize = (value: unknown) => {
  if (value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return 0;
};

const keyToken = (key: IDBValidKey) => JSON.stringify(key);

const digestTokens = (tokens: string[]) => {
  let hash = 0x811c9dc5;
  for (const character of tokens.sort().join('\n')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const emptyCounts = (): Record<SourceStore, number> => ({
  [LEGACY_BOOKS_STORE]: 0,
  [LEGACY_METADATA_STORE]: 0,
  [LEGACY_PROGRESS_STORE]: 0,
  [LEGACY_ARCHIVE_INSPECTIONS_STORE]: 0,
});

export const inspectLegacyInventory = async (
  database?: IDBPDatabase<unknown>,
): Promise<LegacyInventory> => {
  const db = database ?? await initDB();
  const counts = emptyCounts();
  const keyTokens: string[] = [];
  let contentBytes = 0;

  for (const storeName of SOURCE_STORES) {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
    counts[storeName] = keys.length;
    keyTokens.push(...keys.map((key) => `${storeName}:${keyToken(key)}`));
    if (storeName === LEGACY_BOOKS_STORE) {
      contentBytes = values.reduce((total, value) => total + contentSize(value), 0);
    }
    await tx.done;
  }

  return { counts, contentBytes, keyDigest: digestTokens(keyTokens) };
};

const ownerEntries = async (
  db: IDBPDatabase<unknown>,
  storeName: string,
  ownerKey: OwnerKey,
) => {
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const entries: Array<{ key: IDBValidKey; value: unknown }> = [];

  if (store.indexNames.contains('by-owner')) {
    const index = store.index('by-owner');
    const [keys, values] = await Promise.all([
      index.getAllKeys(ownerKey),
      index.getAll(ownerKey),
    ]);
    keys.forEach((key, indexPosition) => entries.push({
      key,
      value: values[indexPosition],
    }));
  } else {
    let cursor = await store.openCursor();
    while (cursor) {
      const key = cursor.primaryKey;
      if (Array.isArray(key) && key[0] === ownerKey) {
        entries.push({ key, value: cursor.value });
      }
      cursor = await cursor.continue();
    }
  }

  await tx.done;
  return entries;
};

export const inspectOwnerInventoryV5 = async (
  ownerKey: OwnerKey,
  database?: IDBPDatabase<unknown>,
): Promise<LegacyInventory> => {
  const db = database ?? await initDB();
  const counts = emptyCounts();
  const keyTokens: string[] = [];
  let contentBytes = 0;

  for (const sourceStore of SOURCE_STORES) {
    const entries = await ownerEntries(db, TARGET_BY_SOURCE[sourceStore], ownerKey);
    counts[sourceStore] = entries.length;
    for (const entry of entries) {
      const key = Array.isArray(entry.key) ? entry.key[1] : entry.key;
      keyTokens.push(`${sourceStore}:${keyToken(key)}`);
      if (sourceStore === LEGACY_BOOKS_STORE) contentBytes += contentSize(entry.value);
    }
  }

  return { counts, contentBytes, keyDigest: digestTokens(keyTokens) };
};

const isQuotaExceededError = (error: unknown) => (
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && error.name === 'QuotaExceededError'
);

const targetValue = (
  sourceStore: SourceStore,
  ownerKey: OwnerKey,
  key: IDBValidKey,
  value: unknown,
) => {
  if (sourceStore === LEGACY_BOOKS_STORE) return value as StoredBookContent;
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${sourceStore}의 ${String(key)} 레코드가 올바르지 않습니다.`);
  }
  return { ...value, ownerKey };
};

const writeMigrationFailure = async (
  db: IDBPDatabase<unknown>,
  migrationId: string,
  error: unknown,
) => {
  const existing = await db.get(V5_MIGRATION_META_STORE, migrationId) as
    MigrationMetaV5 | undefined;
  if (!existing) return;
  await db.put(V5_MIGRATION_META_STORE, {
    ...existing,
    status: 'failed',
    errorName: error instanceof Error ? error.name : 'Error',
    errorMessage: error instanceof Error ? error.message : String(error),
    leaseExpiresAt: 0,
  });
};

export const migrateLegacyDataToOwnerV5 = async (
  ownerKey: OwnerKey,
  options: MigrationOptions,
) => {
  const db = await initDB();
  const now = options.now ?? Date.now;
  const batchSize = Math.max(1, options.batchSize ?? 25);
  const leaseDurationMs = Math.max(1_000, options.leaseDurationMs ?? 30_000);
  const migrationId = migrationIdFor(ownerKey);
  const source = await inspectLegacyInventory(db);

  const leaseTx = db.transaction(V5_MIGRATION_META_STORE, 'readwrite');
  const leaseStore = leaseTx.objectStore(V5_MIGRATION_META_STORE);
  const existing = await leaseStore.get(migrationId) as MigrationMetaV5 | undefined;
  if (existing?.status === 'completed') {
    await leaseTx.done;
    return existing;
  }
  if (
    existing?.status === 'copying'
    && existing.leaseHolder !== options.leaseHolder
    && (existing.leaseExpiresAt ?? 0) > now()
  ) {
    leaseTx.abort();
    await leaseTx.done.catch(() => undefined);
    throw new MigrationLeaseUnavailableError();
  }

  const initial: MigrationMetaV5 = {
    migrationId,
    ownerKey,
    status: 'copying',
    sourceCounts: source.counts,
    copiedCounts: existing?.copiedCounts ?? {},
    sourceContentBytes: source.contentBytes,
    copiedContentBytes: existing?.copiedContentBytes ?? 0,
    sourceKeyDigest: source.keyDigest,
    startedAt: existing?.startedAt ?? now(),
    leaseHolder: options.leaseHolder,
    leaseEpoch: (existing?.leaseEpoch ?? 0) + 1,
    leaseExpiresAt: now() + leaseDurationMs,
  };
  await leaseStore.put(initial);
  await leaseTx.done;

  try {
    for (const sourceStore of SOURCE_STORES) {
      const readTx = db.transaction(sourceStore, 'readonly');
      const sourceObjectStore = readTx.objectStore(sourceStore);
      const [keys, values] = await Promise.all([
        sourceObjectStore.getAllKeys(),
        sourceObjectStore.getAll(),
      ]);
      await readTx.done;

      for (let offset = 0; offset < keys.length; offset += batchSize) {
        const batchKeys = keys.slice(offset, offset + batchSize);
        const batchValues = values.slice(offset, offset + batchSize);
        const targetStore = TARGET_BY_SOURCE[sourceStore];
        const tx = db.transaction([targetStore, V5_MIGRATION_META_STORE], 'readwrite');
        const target = tx.objectStore(targetStore);
        const metaStore = tx.objectStore(V5_MIGRATION_META_STORE);
        const meta = await metaStore.get(migrationId) as MigrationMetaV5;

        if (
          meta.leaseHolder !== options.leaseHolder
          || (meta.leaseExpiresAt ?? 0) <= now()
        ) {
          tx.abort();
          await tx.done.catch(() => undefined);
          throw new MigrationLeaseUnavailableError();
        }

        for (let index = 0; index < batchKeys.length; index += 1) {
          const key = batchKeys[index];
          await target.put(
            targetValue(sourceStore, ownerKey, key, batchValues[index]),
            sourceStore === LEGACY_BOOKS_STORE ? [ownerKey, key] : undefined,
          );
        }

        await metaStore.put({
          ...meta,
          copiedCounts: {
            ...meta.copiedCounts,
            [sourceStore]: offset + batchKeys.length,
          },
          lastStore: sourceStore,
          lastKey: batchKeys.at(-1),
          leaseExpiresAt: now() + leaseDurationMs,
        });
        try {
          options.beforeBatchCommit?.(sourceStore, offset + batchKeys.length);
        } catch (error) {
          tx.abort();
          await tx.done.catch(() => undefined);
          throw error;
        }
        await tx.done;
        await options.onBatchCommitted?.(sourceStore, offset + batchKeys.length);
      }
    }

    const copied = await inspectOwnerInventoryV5(ownerKey, db);
    const verified = SOURCE_STORES.every(
      (storeName) => copied.counts[storeName] === source.counts[storeName],
    ) && copied.contentBytes === source.contentBytes
      && copied.keyDigest === source.keyDigest;

    const current = await db.get(V5_MIGRATION_META_STORE, migrationId) as MigrationMetaV5;
    const result: MigrationMetaV5 = {
      ...current,
      status: verified ? 'completed' : 'failed',
      copiedCounts: copied.counts,
      copiedContentBytes: copied.contentBytes,
      copiedKeyDigest: copied.keyDigest,
      completedAt: verified ? now() : undefined,
      errorName: verified ? undefined : 'MigrationVerificationError',
      errorMessage: verified ? undefined : '이전 결과가 v4 원본 inventory와 일치하지 않습니다.',
      leaseExpiresAt: 0,
    };
    await db.put(V5_MIGRATION_META_STORE, result);
    if (!verified) throw new Error(result.errorMessage);
    return result;
  } catch (error) {
    await writeMigrationFailure(db, migrationId, error);
    if (isQuotaExceededError(error)) throw new LocalStorageCapacityError();
    throw error;
  }
};
