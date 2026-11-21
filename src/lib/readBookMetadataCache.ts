import { openDB, type DBSchema } from 'idb';
import type { OwnerKey } from './ownerIdentity';
import { parsePublicBookMetadata, type PublicBookMetadata } from './publicBookMetadataSchema';

const DATABASE = 'web-reader-read-book-metadata';
const STORE = 'matches';
const BUILD_ID = process.env.NEXT_PUBLIC_APP_BUILD_ID ?? 'development';
const MAX_ENTRIES = 512;
const MATCH_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 5 * 60 * 1000;

export type ConfirmedReadBookMetadata = { metadata: PublicBookMetadata | null; observedAt: number };

type StoredMatch = ConfirmedReadBookMetadata & { expiresAt: number };
export type ReadBookMetadataMatch = Pick<StoredMatch, 'metadata' | 'expiresAt'>;

export function readBookMetadataExpiry({ metadata, observedAt }: ConfirmedReadBookMetadata) {
  return observedAt + (metadata ? MATCH_TTL_MS : MISS_TTL_MS);
}

interface MetadataCache extends DBSchema {
  [STORE]: {
    key: string;
    value: StoredMatch;
    indexes: { 'by-expiry': number };
  };
}

const openCache = () => openDB<MetadataCache>(DATABASE, 1, {
  upgrade(db) {
    db.createObjectStore(STORE).createIndex('by-expiry', 'expiresAt');
  },
});

// The association is device-local. Store only a digest of the account and
// recorded title, never the file name or the reading sessions behind it.
async function keysForTitles(ownerKey: OwnerKey, titles: Iterable<string>) {
  const encoder = new TextEncoder();
  return Promise.all(Array.from(titles, async (title) => {
    const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([BUILD_ID, ownerKey, title])));
    const key = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { title, key };
  }));
}

export async function readCachedReadBookMetadata(ownerKey: OwnerKey, titles: readonly string[]) {
  const matches = new Map<string, ReadBookMetadataMatch>();
  if (titles.length === 0) return matches;

  try {
    const keys = await keysForTitles(ownerKey, titles);
    const db = await openCache();
    try {
      const now = Date.now();
      const transaction = db.transaction(STORE);
      void transaction.done.catch(() => undefined);
      const store = transaction.store;
      const entries = await Promise.all(keys.map(async ({ title, key }) => ({ title, record: await store.get(key) })));
      for (const { title, record } of entries) {
        if (!record || !(record.expiresAt > now)) continue;
        const metadata = parsePublicBookMetadata(record.metadata);
        if (record.metadata !== null && !metadata) continue;
        matches.set(title, { metadata, expiresAt: record.expiresAt });
      }
    } finally {
      db.close();
    }
  } catch {
    // An unavailable cache leaves the regular metadata lookup available.
  }
  return matches;
}

export async function cacheReadBookMetadata(
  ownerKey: OwnerKey,
  matches: ReadonlyMap<string, ConfirmedReadBookMetadata>,
) {
  if (matches.size === 0) return;

  try {
    const keys = await keysForTitles(ownerKey, matches.keys());
    const db = await openCache();
    try {
      const transaction = db.transaction(STORE, 'readwrite');
      void transaction.done.catch(() => undefined);
      const store = transaction.store;
      await Promise.all(keys.map(async ({ title, key }) => {
        const match = matches.get(title)!;
        const previous = await store.get(key);
        if (previous && previous.observedAt > match.observedAt) return;
        await store.put({ ...match, expiresAt: readBookMetadataExpiry(match) }, key);
      }));
      const expiry = store.index('by-expiry');
      const now = Date.now();
      const expired = await expiry.getAllKeys(IDBKeyRange.upperBound(now));
      await Promise.all(expired.map((key) => store.delete(key)));
      const excess = await store.count() - MAX_ENTRIES;
      if (excess > 0) {
        const oldest = await expiry.getAllKeys(null, excess);
        await Promise.all(oldest.map((key) => store.delete(key)));
      }
      await transaction.done;
    } finally {
      db.close();
    }
  } catch {
    // Quota and availability failures must not interrupt the reading list.
  }
}
