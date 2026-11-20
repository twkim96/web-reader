import { type OwnerKey } from './ownerIdentity';
import { trackLocalCommit } from './localCommitTracker';
import type { ReadBook } from './readBooks';

import { BOOK_REVIEW_TEXT_LIMIT, isBookRating } from './publicBookReviews';
export { BOOK_REVIEW_TEXT_LIMIT } from './publicBookReviews';
export type BookReview = Pick<ReadBook, 'totalMs' | 'progressPercent'> & { rating: number; comment: string };
type ReviewStorage = Pick<Storage, 'getItem'>;

const reviewStoragePrefix = (owner: OwnerKey) => {
  if (!/^firebase:[^|]+\|library:local$/.test(owner)) throw new Error('Invalid review owner');
  return `reader_book_review_v1:${encodeURIComponent(owner)}:`;
};
const reviewKey = (owner: OwnerKey, bookId: string) => {
  if (!bookId) throw new Error('Invalid review book');
  return reviewStoragePrefix(owner) + encodeURIComponent(bookId);
};

const isReview = (value: BookReview | null): value is BookReview => Boolean(value
  && isBookRating(value.rating)
  && typeof value.comment === 'string' && value.comment.length <= BOOK_REVIEW_TEXT_LIMIT && !/[\r\n]/.test(value.comment)
  && Number.isFinite(value.totalMs) && value.totalMs >= 0
  && Number.isFinite(value.progressPercent) && value.progressPercent >= 0 && value.progressPercent <= 100);

type ReviewBook = Pick<ReadBook, 'id' | 'equivalentTitleKeys' | 'platformWorkKeys'>;
const reviewKeys = (owner: OwnerKey, book: ReviewBook) => (
  [...new Set([book.id, ...(book.equivalentTitleKeys ?? [])])].sort().map((id) => reviewKey(owner, id))
);

type ReviewGroup = { titles: string[]; platforms: string[]; review: BookReview | null };
const groupsKey = (owner: OwnerKey) => `${reviewKey(owner, '@associations')}:v2`;
const loadGroups = (owner: OwnerKey, storage: ReviewStorage): ReviewGroup[] => {
  const raw = storage.getItem(groupsKey(owner));
  if (raw === null) return [];
  const groups: unknown = JSON.parse(raw);
  if (!Array.isArray(groups) || !groups.every((group) => group && Array.isArray(group.titles)
    && group.titles.every((key: unknown) => typeof key === 'string') && Array.isArray(group.platforms)
    && group.platforms.every((key: unknown) => typeof key === 'string')
    && (group.review === null || isReview(group.review)))) throw new Error('Invalid saved review associations');
  return groups as ReviewGroup[];
};
const identities = (book: ReviewBook) => ({
  titles: [...new Set([book.id, ...(book.equivalentTitleKeys ?? [])])].sort(),
  platforms: [...new Set(book.platformWorkKeys ?? [])].sort(),
});
const intersects = (a: string[], b: string[]) => a.some((key) => b.includes(key));
const matches = (group: ReviewGroup, identity: ReturnType<typeof identities>) => (
  intersects(group.platforms, identity.platforms)
  || ((!group.platforms.length || !identity.platforms.length) && intersects(group.titles, identity.titles))
);

// Merge all known aliases at write time. A null review is a tombstone that prevents
// an older title-keyed copy from reappearing when an alias becomes visible again.
function writeGroup(groups: ReviewGroup[], book: ReviewBook, review: BookReview | null) {
  const identity = identities(book);
  const selected = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    groups.forEach((group, index) => {
      if (selected.has(index) || !matches(group, identity)) return;
      selected.add(index);
      identity.titles = [...new Set([...identity.titles, ...group.titles])].sort();
      identity.platforms = [...new Set([...identity.platforms, ...group.platforms])].sort();
      changed = true;
    });
  }
  return [...groups.filter((_, index) => !selected.has(index)), { ...identity, review }];
}

const DB_NAME = 'twreader-local-book-reviews';
const STORE = 'owners';
const EVENT = 'twreader:book-review-changed';
let channel: BroadcastChannel | null | undefined;
const getChannel = () => {
  if (channel === undefined) {
    try { channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(DB_NAME) : null; }
    catch { channel = null; }
  }
  return channel;
};

function notify(owner: OwnerKey) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: owner }));
  try { getChannel()?.postMessage(owner); } catch { /* Notifications are best effort. */ }
}

export function subscribeBookReviewChanges(owner: OwnerKey, listener: () => void) {
  if (typeof window === 'undefined') return () => {};
  const local = (event: Event) => { if ((event as CustomEvent).detail === owner) listener(); };
  const remote = (event: MessageEvent) => { if (event.data === owner) listener(); };
  window.addEventListener(EVENT, local);
  const bc = getChannel();
  bc?.addEventListener('message', remote);
  return () => { window.removeEventListener(EVENT, local); bc?.removeEventListener('message', remote); };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(owner: OwnerKey, storage: ReviewStorage, action: (groups: ReviewGroup[]) => { groups: ReviewGroup[]; value: T; changed: boolean }): Promise<T> {
  // Validate the owner even when no legacy records exist.
  groupsKey(owner);
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(owner);
      let result: T;
      let changed = false;
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const initial = request.result === undefined;
          const groups = initial ? loadGroups(owner, storage) : request.result as ReviewGroup[];
          const outcome = action(groups);
          result = outcome.value;
          changed = initial || outcome.changed;
          if (changed) store.put(outcome.groups, owner);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => { if (changed) notify(owner); resolve(result); };
      tx.onabort = () => reject(failure ?? tx.error ?? new Error('Review transaction aborted'));
      tx.onerror = () => { /* onabort reports the transaction failure. */ };
    });
  } finally { db.close(); }
}

export function readBookReview(owner: OwnerKey, book: ReviewBook, storage: ReviewStorage): Promise<BookReview | null> {
  return transact(owner, storage, (groups) => {
    const identity = identities(book);
    const matching = groups.filter((group) => matches(group, identity));
    if (matching.length) {
      matching.sort((a, b) => Number(intersects(b.platforms, identity.platforms)) - Number(intersects(a.platforms, identity.platforms))
        || JSON.stringify(a.platforms).localeCompare(JSON.stringify(b.platforms))
        || JSON.stringify(a.titles).localeCompare(JSON.stringify(b.titles)));
      const review = matching[0].review;
      const changed = matching.length > 1 || identity.titles.some((key) => !matching[0].titles.includes(key))
        || identity.platforms.some((key) => !matching[0].platforms.includes(key));
      return { groups: changed ? writeGroup(groups, book, review) : groups, value: review, changed };
    }
    if (identity.platforms.length && groups.some((group) => group.platforms.length && intersects(group.titles, identity.titles))) {
      return { groups, value: null, changed: false };
    }
    for (const key of reviewKeys(owner, book)) {
      const raw = storage.getItem(key);
      if (raw === null) continue;
      const value: BookReview | null = JSON.parse(raw);
      if (!isReview(value)) throw new Error('Invalid saved review');
      return { groups: writeGroup(groups, book, value), value, changed: true };
    }
    return { groups, value: null, changed: false };
  });
}

export function saveBookReview(owner: OwnerKey, book: ReadBook, rating: number, comment: string, storage: ReviewStorage): Promise<BookReview> {
  const review = { rating, comment: comment.trim(), totalMs: book.totalMs, progressPercent: book.progressPercent };
  if (!isReview(review)) return Promise.reject(new Error('Invalid review'));
  return trackLocalCommit(transact(owner, storage, (groups) => ({ groups: writeGroup(groups, book, review), value: review, changed: true })));
}

export function removeBookReview(owner: OwnerKey, book: ReviewBook, storage: ReviewStorage): Promise<void> {
  return trackLocalCommit(transact(owner, storage, (groups) => ({ groups: writeGroup(groups, book, null), value: undefined, changed: true })));
}

export async function listLocalBookReviews(owner: OwnerKey, storage: Pick<Storage, 'length' | 'key' | 'getItem'>) {
  const db = await openDatabase();
  let groups: ReviewGroup[];
  try {
    const persisted = await new Promise<ReviewGroup[] | undefined>((resolve, reject) => {
      const query = db.transaction(STORE).objectStore(STORE).get(owner);
      query.onsuccess = () => resolve(query.result);
      query.onerror = () => reject(query.error);
    });
    groups = persisted ?? loadGroups(owner, storage);
  } finally { db.close(); }
  const titles = new Set(groups.flatMap((group) => group.titles));
  const reviews = groups.flatMap((group) => group.review
    ? [{ workIds: group.titles, platformWorkKeys: group.platforms, review: group.review }]
    : []);
  const prefix = reviewStoragePrefix(owner);
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix) || key === groupsKey(owner)) continue;
    const workId = decodeURIComponent(key.slice(prefix.length));
    if (!workId || titles.has(workId)) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    const review = JSON.parse(raw) as BookReview | null;
    if (isReview(review)) reviews.push({ workIds: [workId], platformWorkKeys: [], review });
  }
  return reviews;
}
