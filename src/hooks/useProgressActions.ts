import { Dispatch, MutableRefObject, SetStateAction, useCallback, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { removeProgressFromLocalV5, saveProgressToLocalV5 } from '../lib/localDBV5';
import { ownerRuntime, type OwnerSnapshot } from '../lib/ownerRuntime';
import { Book, Bookmark, SaveProgressOptions, UserProgress } from '../types';
import { hasProgressChanged, toProgressPercent } from './progressPolicy';
import { enqueueBookmarkEventV5, enqueueProgressEventV5 } from '../lib/syncOutboxV5';
import { diffManualBookmarks, type BookmarkSyncChange } from '../lib/bookmarkSyncPolicy';
import { trackLocalCommit } from '../lib/localCommitTracker';
import { getSyncOwnerKey } from '../lib/ownerIdentity';

interface UseProgressActionsOptions {
  activeBook: Book | null;
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
}

export const useProgressActions = ({
  activeBook,
  user,
  deviceId,
  progressRef,
  setProgress,
}: UseProgressActionsOptions) => {
  const writeTailsRef = useRef(new Map<string, Promise<void>>());
  const sessionIdRef = useRef(crypto.randomUUID());

  const queueProgressWrite = useCallback((
    bookId: string,
    write: () => Promise<void>,
  ) => {
    const previous = writeTailsRef.current.get(bookId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(write);
    writeTailsRef.current.set(bookId, current);

    const cleanup = () => {
      if (writeTailsRef.current.get(bookId) === current) {
        writeTailsRef.current.delete(bookId);
      }
    };
    void current.then(cleanup, cleanup);
    return trackLocalCommit(current);
  }, []);

  const persistProgress = useCallback(async (
    owner: OwnerSnapshot,
    bookId: string,
    progressData: UserProgress,
    bookmarkChanges: BookmarkSyncChange[],
    syncPosition: boolean,
  ) => {
    if (owner.storageMode === 'legacy-readonly' || !ownerRuntime.isCurrent(owner)) return;
    const progressOwnerKey = getSyncOwnerKey(owner.ownerKey);
    try {
      if (!user) {
        await saveProgressToLocalV5(progressOwnerKey, progressData);
        return;
      }
      if (syncPosition) {
        await enqueueProgressEventV5(progressOwnerKey, {
          bookId,
          operation: progressData.cfi ? 'progress.set' : 'progress.reset',
          position: progressData.cfi
            ? {
              cfi: progressData.cfi,
              anchorCfi: progressData.anchorCfi ?? null,
              progressPercent: progressData.progressPercent,
            }
            : null,
          deviceId: deviceId.current,
          sessionId: sessionIdRef.current,
          occurredAtClient: progressData.lastRead,
          localBookmarks: progressData.bookmarks,
        });
      }
      for (const change of bookmarkChanges) {
        await enqueueBookmarkEventV5(progressOwnerKey, {
          bookId,
          bookmarkId: change.bookmarkId,
          operation: change.operation,
          payload: change.payload,
          localBookmarks: progressData.bookmarks ?? [],
          deviceId: deviceId.current,
          sessionId: sessionIdRef.current,
          occurredAtClient: progressData.lastRead,
        });
      }
      if (!syncPosition && bookmarkChanges.length === 0) {
        await saveProgressToLocalV5(progressOwnerKey, progressData);
      }
    } catch (error) {
      console.error('[SaveProgress] local outbox save failed:', error);
    }
  }, [deviceId, user]);

  const saveProgress = useCallback((cfi: number | string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => {
    if (!activeBook) return;
    const owner = ownerRuntime.capture();
    if (!owner) return;
    if (owner.storageMode === 'legacy-readonly') return;

    const bookId = activeBook.id;
    const nextCfi = String(cfi || '');
    if (!nextCfi) return;

    const existing = progressRef.current[bookId];
    const existingPercent = toProgressPercent(existing?.progressPercent);
    const safePercent = toProgressPercent(pct) ?? existingPercent ?? 0;
    const existingBookmarks = existing?.bookmarks || [];
    const finalBookmarks = bookmarks !== undefined ? bookmarks : existingBookmarks;
    const nextAnchorCfi = String(options?.anchorCfi || existing?.anchorCfi || nextCfi);

    if (!options?.force && !hasProgressChanged(existing, nextCfi, nextAnchorCfi, safePercent, finalBookmarks)) {
      return;
    }

    const now = Date.now();
    const progressData: UserProgress = {
      bookId,
      cfi: nextCfi,
      anchorCfi: nextAnchorCfi,
      progressPercent: safePercent,
      lastRead: now,
      bookmarks: finalBookmarks,
    };
    const bookmarkChanges = diffManualBookmarks(existingBookmarks, finalBookmarks, now);
    const syncPosition = Boolean(
      options?.force
      || !existing
      || existing.cfi !== nextCfi
      || (existing.anchorCfi ?? existing.cfi) !== nextAnchorCfi
      || existingPercent !== safePercent,
    );

    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));
    void queueProgressWrite(bookId, () => persistProgress(
      owner,
      bookId,
      progressData,
      bookmarkChanges,
      syncPosition,
    ));
  }, [activeBook, persistProgress, progressRef, queueProgressWrite, setProgress]);

  const deleteProgress = useCallback(async (bookId: string) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    if (owner.storageMode === 'legacy-readonly') return;
    const resetData: UserProgress = {
      bookId,
      cfi: '',
      anchorCfi: '',
      progressPercent: 0,
      lastRead: Date.now(),
      bookmarks: [],
    };
    const bookmarkChanges = diffManualBookmarks(
      progressRef.current[bookId]?.bookmarks,
      [],
      resetData.lastRead,
    );

    setProgress((prev) => ({ ...prev, [bookId]: resetData }));
    progressRef.current = { ...progressRef.current, [bookId]: resetData };

    await queueProgressWrite(bookId, () => persistProgress(
      owner,
      bookId,
      resetData,
      bookmarkChanges,
      true,
    ));
  }, [persistProgress, progressRef, queueProgressWrite, setProgress]);

  const deleteBookProgress = useCallback(async (bookId: string) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    if (owner.storageMode === 'legacy-readonly') return;
    const existing = progressRef.current[bookId];
    const resetData: UserProgress = {
      bookId,
      cfi: '',
      anchorCfi: '',
      progressPercent: 0,
      lastRead: Date.now(),
      bookmarks: [],
    };
    const bookmarkChanges = diffManualBookmarks(
      existing?.bookmarks,
      [],
      resetData.lastRead,
    );
    setProgress((prev) => {
      const next = { ...prev };
      delete next[bookId];
      progressRef.current = next;
      return next;
    });

    await queueProgressWrite(bookId, async () => {
      if (!ownerRuntime.isCurrent(owner)) return;
      try {
        const progressOwnerKey = getSyncOwnerKey(owner.ownerKey);
        if (!user) {
          await removeProgressFromLocalV5(progressOwnerKey, bookId);
          return;
        }
        await persistProgress(
          owner,
          bookId,
          resetData,
          bookmarkChanges,
          true,
        );
        await removeProgressFromLocalV5(progressOwnerKey, bookId);
      } catch (error) {
        console.error('[DeleteBookProgress] outbox reset failed:', error);
      }
    });
  }, [persistProgress, progressRef, queueProgressWrite, setProgress, user]);

  return {
    saveProgress,
    deleteProgress,
    deleteBookProgress,
  };
};
