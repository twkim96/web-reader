import type { Bookmark } from '../types';
import type { ManualBookmarkPayloadV2 } from './progressV2Schema';

export type BookmarkSyncChange =
  | { operation: 'bookmark.upsert'; bookmarkId: string; payload: ManualBookmarkPayloadV2 }
  | { operation: 'bookmark.delete'; bookmarkId: string; payload: null };

export type ManualBookmarkMutation =
  | { kind: 'upsert'; bookmark: Bookmark }
  | { kind: 'delete'; bookmarkId: string };

const manualById = (bookmarks: Bookmark[] | undefined) => new Map(
  (bookmarks ?? [])
    .filter((bookmark) => bookmark.type === 'manual')
    .map((bookmark) => [bookmark.id, bookmark]),
);

const sameBookmark = (left: Bookmark, right: Bookmark) => (
  left.cfi === right.cfi
  && left.name === right.name
  && left.color === right.color
  && (left.progressPercent ?? null) === (right.progressPercent ?? null)
);

const toPayload = (bookmark: Bookmark, now: number): ManualBookmarkPayloadV2 => ({
  bookmarkId: bookmark.id,
  cfi: bookmark.cfi,
  name: bookmark.name,
  color: bookmark.color,
  progressPercent: bookmark.progressPercent ?? null,
  createdAtClient: bookmark.createdAt,
  updatedAtClient: Math.max(bookmark.createdAt, now),
});

export const applyManualBookmarkMutation = (
  bookmarks: Bookmark[] | undefined,
  mutation: ManualBookmarkMutation,
) => {
  const current = bookmarks ?? [];
  if (mutation.kind === 'delete') {
    return current.filter((bookmark) => bookmark.id !== mutation.bookmarkId);
  }
  if (mutation.bookmark.type !== 'manual') {
    throw new Error('수동 북마크 mutation에는 manual bookmark가 필요합니다.');
  }
  return [
    mutation.bookmark,
    ...current.filter((bookmark) => bookmark.id !== mutation.bookmark.id),
  ];
};

export const manualBookmarkMutationToSyncChange = (
  mutation: ManualBookmarkMutation,
  now = Date.now(),
): BookmarkSyncChange => {
  if (mutation.kind === 'delete') {
    return {
      operation: 'bookmark.delete',
      bookmarkId: mutation.bookmarkId,
      payload: null,
    };
  }
  if (mutation.bookmark.type !== 'manual') {
    throw new Error('수동 북마크 mutation에는 manual bookmark가 필요합니다.');
  }
  return {
    operation: 'bookmark.upsert',
    bookmarkId: mutation.bookmark.id,
    payload: toPayload(mutation.bookmark, now),
  };
};

export const diffManualBookmarks = (
  previous: Bookmark[] | undefined,
  next: Bookmark[] | undefined,
  now = Date.now(),
): BookmarkSyncChange[] => {
  const previousById = manualById(previous);
  const nextById = manualById(next);
  const changes: BookmarkSyncChange[] = [];

  for (const [bookmarkId, bookmark] of nextById) {
    const oldBookmark = previousById.get(bookmarkId);
    if (!oldBookmark || !sameBookmark(oldBookmark, bookmark)) {
      changes.push({
        operation: 'bookmark.upsert',
        bookmarkId,
        payload: toPayload(bookmark, now),
      });
    }
  }
  for (const bookmarkId of previousById.keys()) {
    if (!nextById.has(bookmarkId)) {
      changes.push({ operation: 'bookmark.delete', bookmarkId, payload: null });
    }
  }
  return changes;
};
