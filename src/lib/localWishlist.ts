import type { DiscoveryBook } from './bookDiscovery';
import type { OwnerKey } from './ownerIdentity';

export type WishlistEntry = { book: DiscoveryBook; addedAt: number };
type WishlistStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

export const wishlistPrefix = (ownerKey: OwnerKey) => {
  if (typeof ownerKey !== 'string' || !/^(firebase|guest):[^|\s]+\|library:local$/.test(ownerKey)) throw new Error('Invalid wishlist owner');
  return `reader_wishlist_v1:${encodeURIComponent(ownerKey)}:`;
};
const bookKey = (owner: OwnerKey, id: string) => {
  if (!id || typeof id !== 'string') throw new Error('Invalid wishlist book');
  return wishlistPrefix(owner) + encodeURIComponent(id);
};
const parseEntry = (raw: string | null, key: string): WishlistEntry => {
  const entry = raw ? JSON.parse(raw) as WishlistEntry : null;
  const book = entry?.book;
  if (!entry || !book || typeof book.id !== 'string' || !book.id || encodeURIComponent(book.id) !== key || typeof book.title !== 'string' || !Array.isArray(book.platforms) || !Array.isArray(book.tags) || typeof entry.addedAt !== 'number' || !Number.isFinite(entry.addedAt)) throw new Error('Invalid saved wishlist entry');
  return entry;
};
export const readWishlist = (owner: OwnerKey, storage: WishlistStorage): WishlistEntry[] => {
  const prefix = wishlistPrefix(owner);
  const entries: WishlistEntry[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) entries.push(parseEntry(storage.getItem(key), key.slice(prefix.length)));
  }
  return entries.sort((a, b) => b.addedAt - a.addedAt || a.book.id.localeCompare(b.book.id));
};
export const setWishlistSaved = (owner: OwnerKey, book: DiscoveryBook, saved: boolean, storage: WishlistStorage): void => {
  const key = bookKey(owner, book.id);
  if (!saved) {
    storage.removeItem(key);
  } else if (storage.getItem(key) === null) {
    storage.setItem(key, JSON.stringify({ book, addedAt: Date.now() } satisfies WishlistEntry));
  }
};
