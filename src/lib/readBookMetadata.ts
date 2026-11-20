import { getDoc } from 'firebase/firestore';
import type { PublicBookMetadata, PublicBookMetadataDocumentReader } from './publicBookMetadata';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DOCUMENTS = 128;
const MAX_TITLES = 256;
const MAX_CONCURRENT_TITLES = 4;

type CacheEntry<T> = { value: T; expiresAt: number };
const documents = new Map<string, CacheEntry<Awaited<ReturnType<PublicBookMetadataDocumentReader>>>>();
const documentReads = new Map<string, ReturnType<PublicBookMetadataDocumentReader>>();
const titles = new Map<string, CacheEntry<PublicBookMetadata | null>>();
const titleReads = new Map<string, Promise<PublicBookMetadata | null>>();
function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  if (entry.expiresAt <= Date.now()) return undefined;
  cache.set(key, entry);
  return entry;
}

function putCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

const readDocument: PublicBookMetadataDocumentReader = (reference) => {
  const key = reference.path;
  const cached = getCached(documents, key);
  if (cached) return Promise.resolve(cached.value);
  const pending = documentReads.get(key);
  if (pending) return pending;
  const read = getDoc(reference).then((snapshot) => {
    if (!snapshot.exists() && snapshot.metadata.fromCache) throw new Error('Public metadata unavailable offline');
    putCached(documents, key, snapshot, MAX_DOCUMENTS);
    return snapshot;
  }).finally(() => documentReads.delete(key));
  documentReads.set(key, read);
  return read;
};

// Work is shared per title. Callers only schedule a bounded number of titles,
// so cancelling an effect prevents its remaining titles from ever being queued.
function loadTitle(title: string): Promise<PublicBookMetadata | null> {
  const cached = getCached(titles, title);
  if (cached) return Promise.resolve(cached.value);
  const pending = titleReads.get(title);
  if (pending) return pending;
  const read = import('./publicBookMetadata').then(({ loadPublicBookMetadata }) => loadPublicBookMetadata(title, readDocument)).then((metadata) => {
    putCached(titles, title, metadata, MAX_TITLES);
    return metadata;
  }).finally(() => titleReads.delete(title));
  titleReads.set(title, read);
  return read;
}

export type ReadMetadataResult = { metadata: Map<string, PublicBookMetadata | null>; failed: Set<string> };

export function createReadMetadataLoader(readTitle: (title: string) => Promise<PublicBookMetadata | null>) {
  return async (bookTitles: readonly string[], options: {
    signal?: AbortSignal;
    onProgress?: (result: ReadMetadataResult, title: string) => void;
  } = {}): Promise<ReadMetadataResult> => {
    const unique = [...new Set(bookTitles)];
    const result: ReadMetadataResult = { metadata: new Map(), failed: new Set() };
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_TITLES, unique.length) }, async () => {
      while (!options.signal?.aborted && next < unique.length) {
        const title = unique[next++];
        try { result.metadata.set(title, await readTitle(title)); }
        catch { result.failed.add(title); }
        if (!options.signal?.aborted) options.onProgress?.(result, title);
      }
    }));
    return result;
  };
}

export const loadReadBookMetadata = createReadMetadataLoader(loadTitle);
