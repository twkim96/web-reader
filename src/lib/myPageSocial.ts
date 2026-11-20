import type { DiscoveryBook } from './bookDiscovery';
import type { ReadBook } from './readBooks';

export type MyPageVisibility = { reviews: boolean; reading: boolean; wishlist: boolean };
export type MyPageIdentity = { code: string; nickname: string };
export type MyPageAccount = MyPageIdentity & { visibility: MyPageVisibility; revision: number };
export type MyPageWishlistItem = { workId: string; addedAt: number; revision: number; saved: boolean };
export type MyPageSavedBook = { item: MyPageWishlistItem; book: DiscoveryBook; aliases: string[] };
type ReviewWork = {
  workId: string;
  aliases?: string[];
  platformWorkKeys?: string[];
};
export type MyPageReview = ReviewWork & {
  rating: number;
  comment: string;
  totalMs: number | null;
  progressPercent: number | null;
  revision: number;
  title?: string;
  coverUrl?: string | null;
};
export type MyPageReviewDeletion = ReviewWork & { revision: number };
export type MyPageOwnReviews = { reviews: MyPageReview[]; deletions: MyPageReviewDeletion[] };
export type PublicWorkReview = Pick<MyPageReview, 'rating' | 'comment' | 'totalMs' | 'progressPercent'> & { author: MyPageIdentity };
export type PublicWorkReviews = { reviews: PublicWorkReview[]; average: number | null; ratingCount: number };
export type PublicProfileBook = { workId: string; title: string; coverUrl: string | null };
export type PublicMyPage = {
  identity: MyPageIdentity;
  visibility: MyPageVisibility;
  reading?: Array<PublicProfileBook & { status: 'reading' | 'read' }>;
  wishlist?: PublicProfileBook[];
  reviews?: Array<PublicProfileBook & { rating: number; comment: string }>;
  next?: Partial<Record<keyof MyPageVisibility, number | null>>;
};

export const MY_PAGE_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const MY_PAGE_DASHBOARD_BOOK_LIMIT = 12;
export const publicReaderHref = (code: string) => `/people/${encodeURIComponent(code)}`;
export const hasPublicMyPage = (visibility: MyPageVisibility) => visibility.reviews || visibility.reading || visibility.wishlist;
export const formatMyPageIdentity = ({ nickname, code }: MyPageIdentity) => `${nickname}#${code}`;

export function indexReviewWorks<T extends ReviewWork>(entries: readonly T[]) {
  const byTitle = new Map<string, T>();
  const byPlatform = new Map<string, T>();
  for (const entry of entries) {
    for (const id of [entry.workId, ...(entry.aliases ?? [])]) if (!byTitle.has(id)) byTitle.set(id, entry);
    for (const key of entry.platformWorkKeys ?? []) if (!byPlatform.has(key)) byPlatform.set(key, entry);
  }
  return { byTitle, byPlatform };
}

export function findReviewWork<T extends ReviewWork>(
  index: ReturnType<typeof indexReviewWorks<T>>,
  book: Pick<ReadBook, 'id' | 'equivalentTitleKeys' | 'platformWorkKeys'>,
) {
  const platformMatch = book.platformWorkKeys?.map((key) => index.byPlatform.get(key)).find(Boolean);
  return platformMatch ?? index.byTitle.get(book.id)
    ?? book.equivalentTitleKeys?.map((id) => index.byTitle.get(id)).find(Boolean);
}

export function parseMyPageNickname(value: unknown) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
  return /^\p{L}[\p{L}\p{N} _-]{1,19}$/u.test(name) ? name : null;
}

export function parseMyPageVisibility(value: unknown): MyPageVisibility | null {
  if (!value || typeof value !== 'object') return null;
  const { reviews, reading, wishlist } = value as Partial<MyPageVisibility>;
  return typeof reviews === 'boolean' && typeof reading === 'boolean' && typeof wishlist === 'boolean'
    ? { reviews, reading, wishlist } : null;
}
