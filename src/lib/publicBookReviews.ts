import type { BookReview } from './localBookReview';

export const PUBLIC_BOOK_REVIEW_LIMIT = 20;
export const BOOK_REVIEW_TEXT_LIMIT = 120;

// The public projection deliberately contains only the review and its reading evidence.
export function parsePublicBookReview(value: unknown): BookReview | null {
  if (!value || typeof value !== 'object') return null;
  const { rating, comment, totalMs, progressPercent } = value as Record<string, unknown>;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5
    || typeof comment !== 'string' || comment.length > BOOK_REVIEW_TEXT_LIMIT || /[\r\n]/.test(comment)
    || typeof totalMs !== 'number' || !Number.isSafeInteger(totalMs) || totalMs < 0
    || typeof progressPercent !== 'number' || !Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) return null;
  return { rating, comment, totalMs, progressPercent };
}
