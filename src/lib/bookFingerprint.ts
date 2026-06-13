import type { Book } from '../types';

const normalizeSize = (size: Book['size']) => {
  if (typeof size === 'number') return Number.isFinite(size) ? String(size) : null;
  if (!size) return null;
  const parsed = Number(size);
  return Number.isFinite(parsed) ? String(parsed) : null;
};

export const getBookFingerprint = (book: Pick<Book, 'md5Checksum' | 'modifiedTime' | 'size'>) => {
  const checksum = book.md5Checksum?.trim().toLowerCase();
  if (checksum) return `md5:${checksum}`;

  const size = normalizeSize(book.size);
  if (!book.modifiedTime || size === null) return null;
  return `metadata:${book.modifiedTime}:${size}`;
};

export const isCachedBookCurrent = (
  currentBook: Book,
  cachedBook: Book | undefined,
) => {
  if (currentBook.source !== 'cloud') return true;

  const currentFingerprint = getBookFingerprint(currentBook);
  if (!currentFingerprint) return true;
  return currentFingerprint === getBookFingerprint(cachedBook ?? {});
};

export const shouldUseCachedBookContent = (
  currentBook: Book,
  cachedBook: Book | undefined,
  isOnline: boolean,
) => !isOnline || isCachedBookCurrent(currentBook, cachedBook);
