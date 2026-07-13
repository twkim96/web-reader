import { Dispatch, MutableRefObject, SetStateAction, useCallback, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { removeProgressFromLocalV5, saveProgressToLocalV5 } from '../lib/localDBV5';
import { ownerRuntime, type OwnerSnapshot } from '../lib/ownerRuntime';
import { Book, Bookmark, SaveProgressOptions, UserProgress } from '../types';
import { hasProgressChanged, toProgressPercent } from './progressPolicy';
import { enqueueProgressMutationBatchV5 } from '../lib/syncOutboxV5';
import { diffManualBookmarks, type BookmarkSyncChange } from '../lib/bookmarkSyncPolicy';
import { trackLocalCommit } from '../lib/localCommitTracker';
import { getSyncOwnerKey } from '../lib/ownerIdentity';

interface UseProgressActionsOptions {
  activeBook: Book | null;
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  onPersistenceError?: (message: string) => void;
}

export const useProgressActions = ({
  activeBook,
  user,
  deviceId,
  progressRef,
  setProgress,
  onPersistenceError,
}: UseProgressActionsOptions) => {
  const writeTailsRef = useRef(new Map<string, Promise<unknown>>());
  const committedProgressRef = useRef(new Map<string, UserProgress | undefined>());
  const sessionIdRef = useRef(crypto.randomUUID());

  const getCommittedProgress = useCallback((owner: OwnerSnapshot, bookId: string) => {
    const key = `${owner.ownerKey}\u0000${bookId}`;
    if (!committedProgressRef.current.has(key)) {
      committedProgressRef.current.set(key, progressRef.current[bookId]);
    }
    return { key, progress: committedProgressRef.current.get(key) };
  }, [progressRef]);

  const queueProgressWrite = useCallback(<T,>(
    bookId: string,
    write: () => Promise<T>,
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
    if (!ownerRuntime.isCurrent(owner)) return false;
    const progressOwnerKey = getSyncOwnerKey(owner.ownerKey);
    if (!user) {
      await saveProgressToLocalV5(progressOwnerKey, progressData);
      return true;
    }
    if (syncPosition || bookmarkChanges.length > 0) {
      await enqueueProgressMutationBatchV5(progressOwnerKey, {
        progress: progressData,
        progressEvent: syncPosition ? {
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
        } : null,
        bookmarkEvents: bookmarkChanges.map((change) => ({
          bookId,
          bookmarkId: change.bookmarkId,
          operation: change.operation,
          payload: change.payload,
          localBookmarks: progressData.bookmarks ?? [],
          deviceId: deviceId.current,
          sessionId: sessionIdRef.current,
          occurredAtClient: progressData.lastRead,
        })),
      });
    } else {
      await saveProgressToLocalV5(progressOwnerKey, progressData);
    }
    return true;
  }, [deviceId, user]);

  const reportPersistenceError = useCallback((error: unknown) => {
    console.error('[SaveProgress] local commit failed:', error);
    onPersistenceError?.(
      '읽기 위치를 기기에 저장하지 못했습니다. 저장 공간과 브라우저 권한을 확인한 뒤 페이지를 한 번 더 넘겨 다시 시도해 주세요.',
    );
  }, [onPersistenceError]);

  const saveProgress = useCallback(async (cfi: number | string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => {
    if (!activeBook) return false;
    const owner = ownerRuntime.capture();
    if (!owner) return false;

    const bookId = activeBook.id;
    const nextCfi = String(cfi || '');
    if (!nextCfi) return false;

    const displayExisting = progressRef.current[bookId];
    const { key: committedKey, progress: committedExisting } = getCommittedProgress(owner, bookId);
    const committedPercent = toProgressPercent(committedExisting?.progressPercent);
    const safePercent = toProgressPercent(pct)
      ?? toProgressPercent(displayExisting?.progressPercent)
      ?? committedPercent
      ?? 0;
    const committedBookmarks = committedExisting?.bookmarks || [];
    const finalBookmarks = bookmarks !== undefined
      ? bookmarks
      : displayExisting?.bookmarks || committedBookmarks;
    const nextAnchorCfi = String(
      options?.anchorCfi
      || displayExisting?.anchorCfi
      || committedExisting?.anchorCfi
      || nextCfi,
    );

    if (!options?.force && !hasProgressChanged(
      committedExisting,
      nextCfi,
      nextAnchorCfi,
      safePercent,
      finalBookmarks,
    )) {
      return true;
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
    const bookmarkChanges = diffManualBookmarks(committedBookmarks, finalBookmarks, now);
    const syncPosition = Boolean(
      options?.force
      || !committedExisting
      || committedExisting.cfi !== nextCfi
      || (committedExisting.anchorCfi ?? committedExisting.cfi) !== nextAnchorCfi
      || committedPercent !== safePercent,
    );

    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));
    try {
      const committed = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        progressData,
        bookmarkChanges,
        syncPosition,
      ));
      if (committed) committedProgressRef.current.set(committedKey, progressData);
      return committed;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  }, [activeBook, getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress]);

  const deleteProgress = useCallback(async (bookId: string) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    const resetData: UserProgress = {
      bookId,
      cfi: '',
      anchorCfi: '',
      progressPercent: 0,
      lastRead: Date.now(),
      bookmarks: [],
    };
    const { key: committedKey, progress: committedExisting } = getCommittedProgress(owner, bookId);
    const bookmarkChanges = diffManualBookmarks(
      committedExisting?.bookmarks,
      [],
      resetData.lastRead,
    );

    try {
      const committed = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        resetData,
        bookmarkChanges,
        true,
      ));
      if (!committed) return false;
      committedProgressRef.current.set(committedKey, resetData);
      setProgress((prev) => ({ ...prev, [bookId]: resetData }));
      progressRef.current = { ...progressRef.current, [bookId]: resetData };
      return true;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  }, [getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress]);

  const deleteBookProgress = useCallback(async (bookId: string) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    const { key: committedKey, progress: existing } = getCommittedProgress(owner, bookId);
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
          committedProgressRef.current.delete(committedKey);
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
        committedProgressRef.current.delete(committedKey);
      } catch (error) {
        console.error('[DeleteBookProgress] outbox reset failed:', error);
        reportPersistenceError(error);
      }
    });
  }, [getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress, user]);

  return {
    saveProgress,
    deleteProgress,
    deleteBookProgress,
  };
};
