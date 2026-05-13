import { Bookmark, UserProgress } from '../types';

export type TimestampLike = {
  toDate?: () => Date;
};

export type RemoteProgressDoc = {
  bookId?: string;
  cfi?: string;
  anchorCfi?: string;
  progressPercent?: number;
  lastRead?: TimestampLike;
  bookmarks?: Bookmark[];
  deviceId?: string;
};

export const getTimestampMs = (value: unknown, fallback = Date.now()) => {
  const timestamp = value as TimestampLike | undefined;
  const date = timestamp?.toDate ? timestamp.toDate() : undefined;
  return date ? date.getTime() : fallback;
};

export const toProgressPercent = (value: unknown) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  return Math.min(100, Math.max(0, numericValue));
};

export const getBookmarksKey = (items?: Bookmark[]) => JSON.stringify(items || []);

export const getManualBookmarks = (items?: Bookmark[]) => (
  (items || []).filter((bookmark) => bookmark.type === 'manual')
);

export const mergeRemoteManualWithLocalAuto = (
  remoteBookmarks: Bookmark[] = [],
  localBookmarks: Bookmark[] = []
) => {
  const remoteManual = remoteBookmarks.filter((bookmark) => bookmark.type === 'manual');
  const localAuto = localBookmarks.filter((bookmark) => bookmark.type === 'auto');
  return [...remoteManual, ...localAuto].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
};

export const hasProgressChanged = (
  existing: UserProgress | undefined,
  nextCfi: string,
  nextAnchorCfi: string | undefined,
  nextPercent: number,
  nextBookmarks: Bookmark[]
) => {
  if (!existing) return true;

  const existingPercent = toProgressPercent(existing.progressPercent) ?? 0;
  return existing.cfi !== nextCfi ||
    existing.anchorCfi !== nextAnchorCfi ||
    Math.abs(existingPercent - nextPercent) >= 0.05 ||
    getBookmarksKey(existing.bookmarks) !== getBookmarksKey(nextBookmarks);
};

export const hasRemoteProgressChanged = (
  existing: UserProgress | undefined,
  next: UserProgress
) => {
  if (!existing) return true;
  return existing.cfi !== next.cfi ||
    existing.anchorCfi !== next.anchorCfi ||
    existing.progressPercent !== next.progressPercent ||
    getBookmarksKey(existing.bookmarks) !== getBookmarksKey(next.bookmarks);
};
