'use client';

import type { Book } from '../types';
import {
  loadBookCoverFromLocalV14,
  saveBookCoverToLocalV14,
} from './bookCoverCache';
import { normalizeBookCover } from './bookCover';
import { supportsMetadataBookCover } from './bookCoverPolicy';
import { loadPublicBookMetadata } from './publicBookMetadata';
import { getPublicBookCoverCandidates } from './publicBookMetadataSchema';
import type { OwnerKey } from './ownerIdentity';

const abortError = () => new DOMException('Metadata cover fetch aborted', 'AbortError');

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};

const fetchCoverSource = async (coverUrl: string, signal?: AbortSignal) => {
  throwIfAborted(signal);
  const response = await fetch('/api/book-cover/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: coverUrl }),
    signal,
  });
  if (!response.ok) throw new Error(`표지 이미지를 가져오지 못했습니다. (${response.status})`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) throw new Error('표지 응답이 이미지가 아닙니다.');
  const source = await response.blob();
  if (source.size === 0) throw new Error('표지 이미지가 비어 있습니다.');
  return source;
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
