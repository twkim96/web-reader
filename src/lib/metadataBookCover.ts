'use client';

import type { Book } from '../types';
import {
  loadBookCoverFromLocalV14,
  saveBookCoverToLocalV14,
} from './bookCoverCache';
import { normalizeBookCover } from './bookCover';
import { supportsCachedBookCover } from './bookCoverPolicy';
import { getBookFingerprint } from './bookFingerprint';
import { loadPublicBookMetadata } from './publicBookMetadata';
import { getPublicBookCoverCandidates } from './publicBookMetadataSchema';
import type { OwnerKey } from './ownerIdentity';
import { fetchCoverSource } from './bookCoverSource';

type BookCoverOptions = {
  readEmbeddedCover?: () => Promise<Blob | null | undefined>;
  signal?: AbortSignal;
  requireLocalBook?: boolean;
};

const pendingCovers = new Map<string, { promise: Promise<boolean>; signal?: AbortSignal }>();

const fillBookCover = async (
  ownerKey: OwnerKey,
  book: Book,
  { readEmbeddedCover, signal, requireLocalBook = false }: BookCoverOptions,
) => {
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  signal?.throwIfAborted();

  const saveSource = async (source: Blob) => {
    const normalized = await normalizeBookCover(source, signal);
    if (!normalized) return;
    signal?.throwIfAborted();
    return await saveBookCoverToLocalV14(ownerKey, book, normalized, { requireLocalBook, preserveExisting: true });
  };

  if (readEmbeddedCover) {
    try {
      const source = await readEmbeddedCover();
      const saved = source ? await saveSource(source) : undefined;
      if (saved !== undefined) return saved;
    } catch (error) {
      signal?.throwIfAborted();
      console.warn('[BookCover] Embedded cover unavailable, trying metadata cover:', error);
    }
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const metadata = await loadPublicBookMetadata(book.name);
  signal?.throwIfAborted();
  let lastError: unknown;
  for (const { coverUrl } of getPublicBookCoverCandidates(metadata)) {
    try {
      const saved = await saveSource(await fetchCoverSource(coverUrl, signal));
      if (saved !== undefined) return saved;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return false;
};

export const cacheBookCoverIfMissing = async (
  ownerKey: OwnerKey,
  book: Book,
  options: BookCoverOptions = {},
): Promise<boolean> => {
  if (!supportsCachedBookCover(book)) return false;
  options.signal?.throwIfAborted();
  const key = JSON.stringify([ownerKey, book.id, getBookFingerprint(book)]);
  const pending = pendingCovers.get(key);
  if (pending) {
    try {
      const result = await pending.promise;
      if (result || !pending.signal?.aborted) return result;
    } catch (error) {
      if (!pending.signal?.aborted) throw error;
    }
    // A reader can still fill the cover after an overlapping import was cancelled.
    return cacheBookCoverIfMissing(ownerKey, book, options);
  }

  const promise = fillBookCover(ownerKey, book, options).finally(() => pendingCovers.delete(key));
  pendingCovers.set(key, { promise, signal: options.signal });
  return promise;
};
