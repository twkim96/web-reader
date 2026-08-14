import type { RemoteProgressUpdate } from '../types';

export type RemotePositionUpdate = Omit<RemoteProgressUpdate, 'bookmarks'>;

export const mergeRemotePositionUpdates = (
  previous: Record<string, RemoteProgressUpdate>,
  updates: Record<string, RemotePositionUpdate>,
  removedBookIds: ReadonlySet<string> = new Set(),
) => {
  const next = { ...previous };
  for (const [bookId, update] of Object.entries(updates)) {
    const existing = next[bookId];
    if (existing) {
      const existingPosition = { ...existing };
      delete existingPosition.bookmarks;
      next[bookId] = { ...existingPosition, ...update };
    } else {
      next[bookId] = update;
    }
  }
  for (const bookId of removedBookIds) delete next[bookId];
  return next;
};
