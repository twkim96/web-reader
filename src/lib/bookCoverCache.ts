import type { Book } from '../types.ts';
import { getBookFingerprint } from './bookFingerprint.ts';
import { initDB } from './localDB.ts';
import { V14_BOOK_COVERS_STORE } from './localDBSchema.ts';
import type { OwnerKey } from './ownerIdentity.ts';

export const BOOK_COVER_CACHE_CHANGE_EVENT = 'web-reader-book-cover-cache-change';

export type StoredBookCoverV14 = {
  ownerKey: OwnerKey;
  bookId: string;
  fingerprint: string | null;
  image: Blob;
  cachedAt: number;
};

export const notifyBookCoverCacheChanged = (bookId: string) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BOOK_COVER_CACHE_CHANGE_EVENT, {
    detail: { bookId },
  }));
};

export const saveBookCoverToLocalV14 = async (
  ownerKey: OwnerKey,
  book: Book,
  image: Blob,
) => {
  const db = await initDB();
  await db.put(V14_BOOK_COVERS_STORE, {
    ownerKey,
    bookId: book.id,
    fingerprint: getBookFingerprint(book),
    image,
    cachedAt: Date.now(),
  } satisfies StoredBookCoverV14);
  notifyBookCoverCacheChanged(book.id);
};

export const loadBookCoverFromLocalV14 = async (
  ownerKey: OwnerKey,
  book: Book,
) => {
  const db = await initDB();
  const stored = await db.get(
    V14_BOOK_COVERS_STORE,
    [ownerKey, book.id],
  ) as StoredBookCoverV14 | undefined;
  if (
    !stored
    || !(stored.image instanceof Blob)
    || stored.image.size === 0
    || stored.fingerprint !== getBookFingerprint(book)
  ) return null;
  return stored.image;
};

export const removeBookCoverFromLocalV14 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  await db.delete(V14_BOOK_COVERS_STORE, [ownerKey, bookId]);
  notifyBookCoverCacheChanged(bookId);
};
