import { getDoc } from 'firebase/firestore';
import type { OwnerKey } from './ownerIdentity';
import type { PublicBookMetadata, PublicBookMetadataDocumentReader } from './publicBookMetadata';
import { cacheReadBookMetadata, readBookMetadataExpiry, type ConfirmedReadBookMetadata } from './readBookMetadataCache';

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_DOCUMENTS = 128;
const MAX_TITLES = 256;
const MAX_CONCURRENT_TITLES = 4;

type CacheEntry<T> = { value: T; expiresAt: number };
type DocumentLookup = {
  snapshot: Awaited<ReturnType<PublicBookMetadataDocumentReader>>;
  confirmedAt: number | null;
};
const documents = new Map<string, CacheEntry<DocumentLookup>>();
const documentReads = new Map<string, Promise<DocumentLookup>>();
type TitleLookup = { metadata: PublicBookMetadata | null; confirmedAt: number | null; uncertain: boolean };
const titles = new Map<string, CacheEntry<TitleLookup>>();
const titleReads = new Map<string, Promise<TitleLookup>>();
function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  if (entry.expiresAt <= Date.now()) return undefined;
  cache.set(key, entry);
  return entry;
}

function putCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, limit: number, expiresAt: number) {
  cache.delete(key);
  cache.set(key, { value, expiresAt });
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

const readDocument = (reference: Parameters<PublicBookMetadataDocumentReader>[0]): Promise<DocumentLookup> => {
  const key = reference.path;
  const cached = getCached(documents, key);
  if (cached) return Promise.resolve(cached.value);
  const pending = documentReads.get(key);
  if (pending) return pending;
  const startedAt = Date.now();
  const read = getDoc(reference).then((snapshot) => {
    if (!snapshot.exists() && snapshot.metadata.fromCache) throw new Error('Public metadata unavailable offline');
    const result = { snapshot, confirmedAt: snapshot.metadata.fromCache ? null : startedAt };
    putCached(documents, key, result, MAX_DOCUMENTS, startedAt + CACHE_TTL_MS);
    return result;
  }).finally(() => documentReads.delete(key));
  documentReads.set(key, read);
  return read;
};

// Work is shared per title. Callers only schedule a bounded number of titles,
// so cancelling an effect prevents its remaining titles from ever being queued.
function loadTitle(title: string): Promise<TitleLookup> {
  const cached = getCached(titles, title);
  if (cached) return Promise.resolve(cached.value);
  const pending = titleReads.get(title);
  if (pending) return pending;
  const startedAt = Date.now();
  const read = import('./publicBookMetadata').then(async ({ loadPublicBookMetadata }) => {
    // An alias can depend on several documents. Reusing any of them must
    // preserve its original observation time, including shared in-flight reads.
    let confirmedAt: number | null = startedAt;
    let uncertain = false;
    const metadata = await loadPublicBookMetadata(title, async (reference) => {
      const document = await readDocument(reference);
      confirmedAt = confirmedAt === null || document.confirmedAt === null
        ? null : Math.min(confirmedAt, document.confirmedAt);
      return document.snapshot;
    }, () => { uncertain = true; });
    const result = { metadata, confirmedAt, uncertain };
    putCached(titles, title, result, MAX_TITLES, (confirmedAt ?? startedAt) + CACHE_TTL_MS);
    return result;
  }).finally(() => titleReads.delete(title));
  titleReads.set(title, read);
  return read;
}

export type ReadMetadataResult = { metadata: Map<string, PublicBookMetadata | null>; failed: Set<string> };

type ReadMetadataOptions = {
  signal?: AbortSignal;
  onProgress?: (result: ReadMetadataResult, title: string) => void;
};

export function createReadMetadataLoader(readTitle: (title: string) => Promise<PublicBookMetadata | null>) {
  return async (bookTitles: readonly string[], options: ReadMetadataOptions = {}): Promise<ReadMetadataResult> => {
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

export async function loadReadBookMetadata(
  bookTitles: readonly string[],
  options: Omit<ReadMetadataOptions, 'onProgress'> & {
    onProgress?: (result: ReadMetadataResult, title: string, expiresAt?: number) => void;
    cacheOwnerKey?: OwnerKey;
  } = {},
) {
  const confirmed = new Map<string, ConfirmedReadBookMetadata>();
  const uncertainTitles = new Set<string>();
  const load = createReadMetadataLoader(async (title) => {
    const { metadata, confirmedAt, uncertain } = await loadTitle(title);
    if (uncertain) uncertainTitles.add(title);
    else if (confirmedAt !== null) confirmed.set(title, { metadata, observedAt: confirmedAt });
    return metadata;
  });
  const result = await load(bookTitles, {
    signal: options.signal,
    onProgress: options.onProgress && ((progress, title) => {
      const match = confirmed.get(title);
      options.onProgress?.(progress, title, match ? readBookMetadataExpiry(match) : undefined);
    }),
  });
  if (options.cacheOwnerKey && !options.signal?.aborted) {
    void cacheReadBookMetadata(options.cacheOwnerKey, confirmed);
  }
  return { ...result, uncertainTitles };
}
