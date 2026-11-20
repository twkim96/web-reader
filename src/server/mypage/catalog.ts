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
const bucketCaches = new WeakMap<Firestore, Map<string, { expires: number; value: Record<string, unknown> | null }>>();
async function bucket(db: Firestore, id: string) {
  let cache = bucketCaches.get(db);
  if (!cache) { cache = new Map(); bucketCaches.set(db, cache); }
  const cached = cache.get(id);
  if (cached && cached.expires > Date.now()) return cached.value;
  const snapshot = await db.collection('publicBookMetadataV1').doc(id).get();
  const data = snapshot.exists ? snapshot.data() : undefined;
  const value = data?.schemaVersion === 1 && data.entries && typeof data.entries === 'object' && !Array.isArray(data.entries) ? data.entries as Record<string, unknown> : null;
  cache.set(id, { expires: Date.now() + 60_000, value });
  return value;
}

async function titleRoots(db: Firestore, catalog: Index, requestedId: string, checkAllAliases = false) {
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
  // On-demand metadata can contain a private queryTitle. Only link it by an
  // already-published platform URL; never return any on-demand fields.
  for (const id of checkAllAliases ? ids : ids.slice(0, 1)) {
    const snapshot = await db.collection('publicBookMetadataOnDemandV1').doc(id).get();
    const data = snapshot.exists ? snapshot.data() : undefined;
    if (data?.schemaVersion !== 1 || data.status !== 'ready' || data.aliasId !== id || !Array.isArray(data.platforms)) continue;
    for (const item of data.platforms) {
      if (!item || typeof item !== 'object' || typeof item.platform !== 'string' || typeof item.url !== 'string') continue;
      const root = catalog.platforms.get(platformWorkKey(item.platform, item.url));
      if (root) roots.add(root);
    }
    if (roots.size > 1) break;
  }
  return roots;
}

export async function resolveSocialWork(
  db: Firestore,
  requestedId: string,
  platformWorkKeys: readonly string[] = [],
): Promise<ResolvedWork | null> {
  const catalog = await index();
  // Only the server's published index can turn a platform link into a work.
  // An on-demand result can include links that have not been published yet.
  const platformRoots = new Set(platformWorkKeys.map((key) => catalog.platforms.get(key)).filter(Boolean));
  if (platformRoots.size > 1) return null;
  const [platformRoot] = platformRoots;
  if (platformRoot) return catalogWork(catalog, platformRoot);
  const roots = await titleRoots(db, catalog, requestedId);
  return roots.size === 1 ? catalogWork(catalog, [...roots][0]) : null;
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
    for (const root of await titleRoots(db, catalog, id, true)) roots.add(root);
    if (roots.size > 1) return null;
  }
  return roots.size === 1 ? catalogWork(catalog, [...roots][0]) : null;
}
