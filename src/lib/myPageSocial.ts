import type { DiscoveryBook } from './bookDiscovery';
import type { ReadBook } from './readBooks';

export type MyPageVisibility = { reviews: boolean; wishlist: boolean };
export type MyPageBrowseSection = keyof MyPageVisibility;
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
export type PublicBrowseBook = PublicProfileBook & { rating?: number; comment?: string };
export type PublicBrowseGroup = { reader: MyPageIdentity; books: PublicBrowseBook[] };
export type PublicBrowsePage = { groups: PublicBrowseGroup[]; next: string | null };
export type PublicMyPage = {
  identity: MyPageIdentity;
  visibility: MyPageVisibility;
  wishlist?: PublicProfileBook[];
  reviews?: Array<PublicProfileBook & { rating: number; comment: string }>;
  next?: Partial<Record<keyof MyPageVisibility, number | null>>;
};

export const MY_PAGE_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const MY_PAGE_DASHBOARD_BOOK_LIMIT = 12;
export const REVIEW_LIST_SORTS = [
  ['recent', '최근 평가순'],
  ['rating-desc', '별점 높은 순'],
  ['rating-asc', '별점 낮은 순'],
] as const;
export type ReviewListSort = typeof REVIEW_LIST_SORTS[number][0];

export function sortReviewList<T extends { rating: number }>(reviews: readonly T[], sort: ReviewListSort) {
  if (sort === 'recent') return reviews;
  const direction = sort === 'rating-desc' ? -1 : 1;
  return [...reviews].sort((a, b) => direction * (a.rating - b.rating));
}
export const publicReaderHref = (code: string) => `/people/${encodeURIComponent(code)}`;
export const hasPublicMyPage = (visibility: MyPageVisibility) => visibility.reviews || visibility.wishlist;
export const formatMyPageIdentity = ({ nickname, code }: MyPageIdentity) => `${nickname}#${code}`;

export function indexReviewWorks<T extends ReviewWork>(entries: readonly T[]) {
  const byTitle = new Map<string, Set<T>>();
  const byPlatform = new Map<string, Set<T>>();
  const add = (index: Map<string, Set<T>>, key: string, entry: T) => {
    const matches = index.get(key);
    if (matches) matches.add(entry);
    else index.set(key, new Set([entry]));
  };
  for (const entry of entries) {
    for (const id of [entry.workId, ...(entry.aliases ?? [])]) add(byTitle, id, entry);
    for (const key of entry.platformWorkKeys ?? []) add(byPlatform, key, entry);
  }
  return { byTitle, byPlatform };
}

export function resolveReviewWork<T extends ReviewWork>(
  index: ReturnType<typeof indexReviewWorks<T>>,
  book: Pick<ReadBook, 'id' | 'equivalentTitleKeys' | 'platformWorkKeys'>,
) {
  const keys = book.platformWorkKeys ?? [];
  const platformMatches = new Set(keys.flatMap((key) => [...(index.byPlatform.get(key) ?? [])]));
  const exact = index.byTitle.get(book.id);
  const matches = keys.length ? platformMatches : new Set(
    [book.id, ...(book.equivalentTitleKeys ?? [])].flatMap((id) => [...(index.byTitle.get(id) ?? [])]),
  );
  const blocked = matches.size > 1 || (!matches.size && [...(exact ?? [])].some((entry) => entry.workId === book.id));
  return { entry: matches.size === 1 ? [...matches][0] : undefined, blocked };
}

export function findReviewWork<T extends ReviewWork>(
  index: ReturnType<typeof indexReviewWorks<T>>,
  book: Pick<ReadBook, 'id' | 'equivalentTitleKeys' | 'platformWorkKeys'>,
) {
  return resolveReviewWork(index, book).entry;
}

export function parseMyPageNickname(value: unknown) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
  return /^\p{L}[\p{L}\p{N} _-]{1,19}$/u.test(name) ? name : null;
}

export function parseMyPageVisibility(value: unknown): MyPageVisibility | null {
  if (!value || typeof value !== 'object') return null;
  const { reviews, wishlist } = value as Partial<MyPageVisibility>;
  return typeof reviews === 'boolean' && typeof wishlist === 'boolean' ? { reviews, wishlist } : null;
}
