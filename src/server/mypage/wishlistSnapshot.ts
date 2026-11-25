import type { DocumentReference, DocumentSnapshot, Transaction } from 'firebase-admin/firestore';
import type { MyPageWishlistItem } from '../../lib/myPageSocial.ts';

export const WISHLIST_SNAPSHOT_ROW_LIMIT = 2_000;
const snapshotByteLimit = 512 * 1024;

type Entry = [workId: string, revision: number, addedAt: number];
type Snapshot = { saved: Entry[]; removed: Entry[] };

export function wishlistSnapshotGeneration() {
  const generation = process.env.MY_PAGE_WISHLIST_SNAPSHOT_GENERATION;
  return generation && /^[a-zA-Z0-9_-]{1,64}$/.test(generation) ? generation : null;
}

function isEntry(value: unknown): value is Entry {
  return Array.isArray(value) && value.length === 3
    && typeof value[0] === 'string' && Boolean(value[0].trim())
    && Number.isSafeInteger(value[1]) && value[1] > 0
    && Number.isFinite(value[2]);
}

// undefined means an initial snapshot is needed. null uses the legacy store
// for this generation, including accounts beyond the single-document limit.
export function readWishlistSnapshot(document: DocumentSnapshot, generation: string): MyPageWishlistItem[] | null | undefined {
  if (document.get('generation') !== generation) return undefined;
  const payload: unknown = document.get('payload');
  if (payload === null) return null;
  if (typeof payload !== 'string' || Buffer.byteLength(payload) > snapshotByteLimit) return undefined;
  let parsed: Partial<Snapshot> | null;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (!parsed || !Array.isArray(parsed.saved) || !Array.isArray(parsed.removed)
    || parsed.saved.length + parsed.removed.length > WISHLIST_SNAPSHOT_ROW_LIMIT
    || !parsed.saved.every(isEntry) || !parsed.removed.every(isEntry)) return undefined;
  const items = [
    ...parsed.saved.map(([workId, revision, addedAt]) => ({ workId, revision, addedAt, saved: true })),
    ...parsed.removed.map(([workId, revision, addedAt]) => ({ workId, revision, addedAt, saved: false })),
  ];
  return new Set(items.map(({ workId }) => workId)).size === items.length ? items : undefined;
}

export function writeWishlistSnapshot(
  transaction: Transaction, ref: DocumentReference, generation: string, items: readonly MyPageWishlistItem[],
) {
  let payload: string | null = null;
  if (items.length <= WISHLIST_SNAPSHOT_ROW_LIMIT) {
    const snapshot: Snapshot = { saved: [], removed: [] };
    for (const { workId, revision, addedAt, saved } of items) {
      const entry: Entry = [workId, revision, addedAt];
      if (!isEntry(entry) || typeof saved !== 'boolean') break;
      snapshot[saved ? 'saved' : 'removed'].push(entry);
    }
    if (snapshot.saved.length + snapshot.removed.length === items.length
      && new Set(items.map(({ workId }) => workId)).size === items.length) {
      const encoded = JSON.stringify(snapshot);
      if (Buffer.byteLength(encoded) <= snapshotByteLimit) payload = encoded;
    }
  }
  transaction.set(ref, { generation, payload });
  return payload === null ? null : items;
}
