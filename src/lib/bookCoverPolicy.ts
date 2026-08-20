import type { Book } from '../types.ts';
import { getSourceBookFormat } from './bookFormats.ts';

export const BOOK_COVER_MAX_WIDTH = 480;
export const BOOK_COVER_MAX_HEIGHT = 720;
export const BOOK_COVER_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export const supportsCachedBookCover = (
  book: Pick<Book, 'name' | 'mimeType' | 'sourceFormat'>,
) => {
  const format = book.sourceFormat ?? getSourceBookFormat(book.name, book.mimeType);
  return format === 'epub'
    || format === 'pdf'
    || format === 'zip'
    || format === 'cbz';
};

export const getBookCoverTargetSize = (width: number, height: number) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const scale = Math.min(
    1,
    BOOK_COVER_MAX_WIDTH / width,
    BOOK_COVER_MAX_HEIGHT / height,
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};
