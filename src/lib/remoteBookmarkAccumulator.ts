import type { Bookmark } from '../types';
import type { BookmarkHeadV2 } from './progressV2Schema';

export type RemoteBookmarkHeadChange =
  | { type: 'upsert'; head: BookmarkHeadV2 }
  | { type: 'remove'; bookmarkId: string };

export const applyRemoteBookmarkHeadChanges = (
  current: ReadonlyMap<string, BookmarkHeadV2>,
  changes: RemoteBookmarkHeadChange[],
) => {
  const next = new Map(current);
  for (const change of changes) {
    if (change.type === 'remove') next.delete(change.bookmarkId);
    else next.set(change.head.bookmarkId, change.head);
  }
  return next;
};

export const mergeAccumulatedRemoteBookmarks = (
  localBookmarks: Bookmark[],
  heads: ReadonlyMap<string, BookmarkHeadV2>,
) => {
  const manual = new Map(localBookmarks
    .filter((bookmark) => bookmark.type === 'manual')
    .map((bookmark) => [bookmark.id, bookmark]));
  for (const head of heads.values()) {
    if (head.operation === 'delete') {
      manual.delete(head.bookmarkId);
      continue;
    }
    manual.set(head.bookmarkId, {
      id: head.bookmarkId,
      type: 'manual',
      name: head.bookmark!.name,
      cfi: head.bookmark!.cfi,
      progressPercent: head.bookmark!.progressPercent ?? undefined,
      createdAt: head.bookmark!.createdAtClient,
      color: head.bookmark!.color,
    });
  }
  return [
    ...manual.values(),
    ...localBookmarks.filter((bookmark) => bookmark.type === 'auto'),
  ];
};
