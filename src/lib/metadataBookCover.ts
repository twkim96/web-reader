'use client';

import type { Book } from '../types';
import {
  loadBookCoverFromLocalV14,
  saveBookCoverToLocalV14,
} from './bookCoverCache';
import {
  cacheOpenedBookCoverIfMissing,
  normalizeBookCover,
} from './bookCover';
import {
  supportsEmbeddedBookCover,
  supportsMetadataBookCover,
} from './bookCoverPolicy';
import { loadPublicBookMetadata } from './publicBookMetadata';
import { getPublicBookCoverCandidates } from './publicBookMetadataSchema';
import type { OwnerKey } from './ownerIdentity';
import { fetchCoverSource } from './bookCoverSource';

const abortError = () => new DOMException('Metadata cover fetch aborted', 'AbortError');

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};

export const cacheMetadataBookCoverIfMissing = async (
  ownerKey: OwnerKey,
  book: Book,
  signal?: AbortSignal,
) => {
  if (!supportsMetadataBookCover(book)) return false;
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  throwIfAborted(signal);
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  const metadata = await loadPublicBookMetadata(book.name);
  const candidates = getPublicBookCoverCandidates(metadata);
  if (candidates.length === 0) return false;

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const source = await fetchCoverSource(candidate.coverUrl, signal);
      const normalized = await normalizeBookCover(source, signal);
      if (!normalized) continue;
      throwIfAborted(signal);
      if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
      await saveBookCoverToLocalV14(ownerKey, book, normalized);
      return true;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return false;
};

export const cacheReaderBookCoverIfMissing = async (
  ownerKey: OwnerKey,
  book: Book,
  openedView?: Parameters<typeof cacheOpenedBookCoverIfMissing>[2],
  signal?: AbortSignal,
) => {
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  throwIfAborted(signal);

  if (openedView && supportsEmbeddedBookCover(book)) {
    try {
      if (await cacheOpenedBookCoverIfMissing(ownerKey, book, openedView, signal)) {
        return true;
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      console.warn('[Reader] Embedded cover unavailable, trying metadata cover:', error);
    }
  }

  return cacheMetadataBookCoverIfMissing(ownerKey, book, signal);
};
