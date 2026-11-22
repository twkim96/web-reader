import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Firestore } from 'firebase-admin/firestore';
import { groupDiscoveryBooks, parseDiscoveryIndex, type DiscoveryBook } from '../../lib/bookDiscovery';
import { getPublicBookMetadataAliasCandidates, parsePublicBookMetadata } from '../../lib/publicBookMetadataSchema';
import { platformWorkKey } from '../../lib/readBooks';

type Index = ReturnType<typeof groupDiscoveryBooks>;
type ResolvedWork = { book: DiscoveryBook; equivalentWorkIds: string[] };
let pending: Promise<Index> | undefined;

async function index(): Promise<Index> {
  pending ??= readFile(join(process.cwd(), 'public/catalog/discovery.v1.json'), 'utf8')
    .then((json) => groupDiscoveryBooks(parseDiscoveryIndex(JSON.parse(json))))
    .catch((error) => { pending = undefined; throw error; });
  return pending;
}

// Both raw published title keys and their lexicographically smallest connected root
// map to the same canonical book. Values never contain a local query title.
export async function loadSocialCatalog(): Promise<Map<string, DiscoveryBook>> {
  return new Map((await index()).byId);
}

const catalogWork = (catalog: Index, id: string): ResolvedWork | null => {
  const book = catalog.byId.get(id);
  return book ? { book, equivalentWorkIds: catalog.equivalents.get(book.id)! } : null;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type CachedLookup<T> = { expires: number; value: Promise<T> };
type OnDemandMatch = { roots: readonly string[]; uncertain: boolean };
type OnDemandRead = 'cached' | 'fresh';

const bucketCaches = new WeakMap<Firestore, Map<string, CachedLookup<Record<string, unknown> | null>>>();
const onDemandCaches = new WeakMap<Firestore, Map<string, CachedLookup<OnDemandMatch>>>();

async function cachedLookup<T>(
  caches: WeakMap<Firestore, Map<string, CachedLookup<T>>>,
  db: Firestore,
  id: string,
  limit: number,
  load: () => Promise<T>,
  ttl: (value: T) => number,
) {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const cached = cache.get(id);
  cache.delete(id);
  if (cached && cached.expires > Date.now()) {
    cache.set(id, cached);
    return cached.value;
  }
  const entry = { expires: Infinity, value: load() };
  cache.set(id, entry);
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
  try {
    const result = await entry.value;
    const duration = ttl(result);
    if (duration > 0) entry.expires = Date.now() + duration;
    else if (cache.get(id) === entry) cache.delete(id);
    return result;
  } catch (error) {
    if (cache.get(id) === entry) cache.delete(id);
    throw error;
  }
}

function bucket(db: Firestore, id: string) {
  return cachedLookup(bucketCaches, db, id, 256, async () => {
    const { entries, schemaVersion } = (await db.collection('publicBookMetadataV1').doc(id).get()).data() ?? {};
    return schemaVersion === 1 && entries && typeof entries === 'object' && !Array.isArray(entries)
      ? entries as Record<string, unknown> : null;
  }, () => 60_000);
}

async function readOnDemandMatch(db: Firestore, catalog: Index, id: string): Promise<OnDemandMatch> {
  const snapshot = await db.collection('publicBookMetadataOnDemandV1').doc(id).get();
  const data = snapshot.exists ? snapshot.data() : undefined;
  if (!data) return { roots: [], uncertain: false };
  if (data.schemaVersion !== 1 || data.aliasId !== id) return { roots: [], uncertain: true };
  if (data.status === 'not-found') return { roots: [], uncertain: false };
  if (data.status !== 'ready' || !Array.isArray(data.platforms)) return { roots: [], uncertain: true };
  // Cache only links that already resolve to a published work. The document
  // may also contain a private query title or other on-demand fields.
  const roots = new Set<string>();
  for (const item of data.platforms) {
    if (!item || typeof item !== 'object' || typeof item.platform !== 'string' || typeof item.url !== 'string') continue;
    const root = catalog.platforms.get(platformWorkKey(item.platform, item.url));
    if (root) roots.add(root);
    if (roots.size > 1) break;
  }
  return { roots: [...roots], uncertain: false };
}

async function titleRoots(
  db: Firestore, catalog: Index, requestedId: string, onDemand: OnDemandRead,
  checkAllAliases = false, markUncertain?: () => void,
) {
  const roots = new Set<string>();
  if (typeof requestedId !== 'string' || !requestedId.trim() || requestedId.length > 1000) return roots;
  const published = catalog.byId.get(requestedId);
  if (published) return roots.add(published.id);
  const ids = getPublicBookMetadataAliasCandidates(requestedId).map(hash);
  if (!ids.length) return roots;
  const buckets = await Promise.all([...new Set(ids.map((id) => id.slice(0, 2)))].map(async (id) => [id, await bucket(db, id)] as const));
  const byBucket = new Map(buckets);
  let hasPublishedMetadata = false;
  for (const id of ids) {
    const metadata = parsePublicBookMetadata(byBucket.get(id.slice(0, 2))?.[id]);
    if (!metadata) continue;
    hasPublishedMetadata = true;
    for (const { platform, url } of metadata.platforms) {
      const root = catalog.platforms.get(platformWorkKey(platform, url));
      if (root) roots.add(root);
    }
    const direct = catalog.byId.get(metadata.titleKey);
    if (direct) roots.add(direct.id);
    if (!checkAllAliases || roots.size > 1) return roots;
  }
  if (hasPublishedMetadata) return roots;
  for (const id of checkAllAliases ? ids : ids.slice(0, 1)) {
    const load = () => readOnDemandMatch(db, catalog, id);
    const match = onDemand === 'fresh' ? await load() : await cachedLookup(
      onDemandCaches, db, id, 2_000, load,
      ({ roots, uncertain }) => uncertain || roots.length > 1 ? 0 : roots.length ? 60_000 : 15_000,
    );
    if (match.uncertain) markUncertain?.();
    for (const root of match.roots) roots.add(root);
    if (roots.size > 1) break;
  }
  return roots;
}

export async function resolveSocialWork(
  db: Firestore,
  requestedId: string,
  platformWorkKeys: readonly string[] = [],
  onDemand: OnDemandRead = 'cached',
): Promise<ResolvedWork | null> {
  const catalog = await index();
  // Only the server's published index can turn a platform link into a work.
  // An on-demand result can include links that have not been published yet.
  const platformRoots = new Set(platformWorkKeys.map((key) => catalog.platforms.get(key)).filter(Boolean));
  if (platformWorkKeys.length && platformRoots.size === 0) return null;
  if (platformRoots.size > 1) return null;
  const [platformRoot] = platformRoots;
  if (platformRoot) return catalogWork(catalog, platformRoot);
  const roots = await titleRoots(db, catalog, requestedId, onDemand);
  return roots.size === 1 ? catalogWork(catalog, [...roots][0]) : null;
}

export async function resolveWishlistWork(
  db: Firestore, requestedId: string, onDemand: OnDemandRead = 'cached',
): Promise<ResolvedWork | null> {
  const catalog = await index();
  const roots = await titleRoots(db, catalog, requestedId, onDemand, true);
  return roots.size === 1 ? catalogWork(catalog, [...roots][0]) : null;
}

export async function resolveSocialReadingTitle(db: Firestore, title: string) {
  let uncertain = false;
  const roots = await titleRoots(db, await index(), title, 'cached', false, () => { uncertain = true; });
  return { roots, uncertain };
}

export async function resolveLegacyReviewWork(
  db: Firestore, workIds: readonly string[], platformWorkKeys: readonly string[],
): Promise<ResolvedWork | null> {
  const catalog = await index();
  if (platformWorkKeys.length) {
    const root = catalog.platforms.get(platformWorkKeys[0]);
    if (!root || !platformWorkKeys.every((key) => catalog.platforms.get(key) === root)) return null;
    return catalogWork(catalog, root);
  }

  const roots = new Set<string>();
  for (const id of new Set(workIds)) {
    for (const root of await titleRoots(db, catalog, id, 'fresh', true)) roots.add(root);
    if (roots.size > 1) return null;
  }
  return roots.size === 1 ? catalogWork(catalog, [...roots][0]) : null;
}
