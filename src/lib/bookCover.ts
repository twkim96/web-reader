'use client';

import type { Book } from '../types.ts';
import type { FoliateViewElement } from '../hooks/foliate/types.ts';
import {
  loadBookCoverFromLocalV14,
  saveBookCoverToLocalV14,
} from './bookCoverCache.ts';
import { waitForFoliateViewRegistration } from './foliateRuntimeLoader.ts';
import type { OwnerKey } from './ownerIdentity.ts';
import {
  BOOK_COVER_MAX_SOURCE_BYTES,
  getBookCoverTargetSize,
  supportsCachedBookCover,
} from './bookCoverPolicy.ts';

export {
  BOOK_COVER_MAX_HEIGHT,
  BOOK_COVER_MAX_SOURCE_BYTES,
  BOOK_COVER_MAX_WIDTH,
  getBookCoverTargetSize,
  supportsCachedBookCover,
} from './bookCoverPolicy.ts';

const abortError = () => new DOMException('Cover generation aborted', 'AbortError');

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError();
};

const loadImage = async (source: Blob, signal?: AbortSignal) => {
  throwIfAborted(signal);
  const objectUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = 'async';
    const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      image.onload = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(image);
      };
      image.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new Error('표지 이미지를 해석하지 못했습니다.'));
      };
    });
    image.src = objectUrl;
    return await loaded;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

export const normalizeBookCover = async (source: Blob, signal?: AbortSignal) => {
  if (source.size === 0 || source.size > BOOK_COVER_MAX_SOURCE_BYTES) return null;
  const image = await loadImage(source, signal);
  throwIfAborted(signal);
  const size = getBookCoverTargetSize(image.naturalWidth, image.naturalHeight);
  if (!size) return null;

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, size.width, size.height);
  throwIfAborted(signal);

  const webp = await canvasToBlob(canvas, 'image/webp', 0.82);
  if (webp?.type === 'image/webp') return webp;
  return await canvasToBlob(canvas, 'image/jpeg', 0.86);
};

const normalizeAndSaveBookCover = async (
  ownerKey: OwnerKey,
  book: Book,
  source: Blob,
  signal?: AbortSignal,
) => {
  const normalized = await normalizeBookCover(source, signal);
  if (!normalized) return false;
  throwIfAborted(signal);
  await saveBookCoverToLocalV14(ownerKey, book, normalized);
  return true;
};

export const cacheBookCoverSourceIfMissing = async (
  ownerKey: OwnerKey,
  book: Book,
  source: Blob,
  signal?: AbortSignal,
) => {
  if (!supportsCachedBookCover(book)) return false;
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  return await normalizeAndSaveBookCover(ownerKey, book, source, signal);
};

const saveOpenedBookCover = async (
  ownerKey: OwnerKey,
  book: Book,
  view: FoliateViewElement,
  signal?: AbortSignal,
) => {
  if (!supportsCachedBookCover(book)) return false;
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  throwIfAborted(signal);
  const source = await view.book?.getCover?.();
  if (!source) return false;
  return await normalizeAndSaveBookCover(ownerKey, book, source, signal);
};

export const cacheOpenedBookCoverIfMissing = saveOpenedBookCover;

export const cacheImportedBookCoverIfMissing = async (
  ownerKey: OwnerKey,
  book: Book,
  source: File,
  signal?: AbortSignal,
) => {
  if (!supportsCachedBookCover(book)) return false;
  if (await loadBookCoverFromLocalV14(ownerKey, book)) return true;
  throwIfAborted(signal);
  await waitForFoliateViewRegistration();
  throwIfAborted(signal);

  const view = document.createElement('foliate-view') as FoliateViewElement;
  if (typeof view.open !== 'function') {
    throw new Error('표지 추출기를 준비하지 못했습니다.');
  }
  try {
    await view.open(source);
    return await saveOpenedBookCover(ownerKey, book, view, signal);
  } finally {
    try {
      view.close?.();
      view.remove();
    } catch {
      // Cover extraction is best-effort and must not block a completed import.
    }
  }
};
