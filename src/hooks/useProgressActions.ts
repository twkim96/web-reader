import { Dispatch, MutableRefObject, SetStateAction, useCallback, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { removeProgressFromLocalV5, saveProgressToLocalV5 } from '../lib/localDBV5';
import { ownerRuntime, type OwnerSnapshot } from '../lib/ownerRuntime';
import {
  Book,
  Bookmark,
  RemoteProgressAdoptionResult,
  RemoteProgressUpdate,
  SaveProgressOptions,
  UserProgress,
} from '../types';
import { hasProgressChanged, toProgressPercent } from './progressPolicy';
import {
  adoptRemoteProgressLocallyV5,
  enqueueProgressMutationBatchV5,
  markRemoteProgressIgnoredV5,
} from '../lib/syncOutboxV5';
import { diffManualBookmarks, type BookmarkSyncChange } from '../lib/bookmarkSyncPolicy';
import { trackLocalCommit } from '../lib/localCommitTracker';
import { getSyncOwnerKey } from '../lib/ownerIdentity';
import {
  clearProgressCommitBaseline,
  getProgressCommitBaseline,
  rebaseProgressCommitBaseline,
} from '../lib/progressCommitBaseline';
import { getSyncSessionId } from '../lib/syncSession';

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
  const sessionIdRef = useRef(getSyncSessionId());

  const getCommittedProgress = useCallback((owner: OwnerSnapshot, bookId: string) => {
    return getProgressCommitBaseline(owner.ownerKey, bookId, progressRef.current[bookId]);
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
    bookmarkOccurredAtClient = progressData.lastRead,
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
          occurredAtClient: bookmarkOccurredAtClient,
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
    const committedExisting = getCommittedProgress(owner, bookId);
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
      syncRevision: committedExisting?.syncRevision,
      acceptedEventId: committedExisting?.acceptedEventId,
      ignoredRemoteRevision: committedExisting?.ignoredRemoteRevision
        ?? displayExisting?.ignoredRemoteRevision,
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
      if (committed) rebaseProgressCommitBaseline(owner.ownerKey, bookId, progressData);
      return committed;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  }, [activeBook, getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress]);

  const saveBookmarks = useCallback(async (bookId: string, bookmarks: Bookmark[]) => {
    if (!activeBook || activeBook.id !== bookId) return false;
    const owner = ownerRuntime.capture();
    if (!owner) return false;

    const displayExisting = progressRef.current[bookId];
    const committedExisting = getCommittedProgress(owner, bookId);
    const previousBookmarks = displayExisting?.bookmarks ?? committedExisting?.bookmarks ?? [];
    const now = Date.now();
    const bookmarkChanges = diffManualBookmarks(previousBookmarks, bookmarks, now);
    if (bookmarkChanges.length === 0) return true;

    const progressData: UserProgress = {
      bookId,
      cfi: displayExisting?.cfi ?? committedExisting?.cfi ?? '',
      anchorCfi: displayExisting?.anchorCfi
        ?? committedExisting?.anchorCfi
        ?? displayExisting?.cfi
        ?? committedExisting?.cfi
        ?? '',
      progressPercent: toProgressPercent(displayExisting?.progressPercent)
        ?? toProgressPercent(committedExisting?.progressPercent)
        ?? 0,
      lastRead: displayExisting?.lastRead ?? committedExisting?.lastRead ?? 0,
      bookmarks,
      syncRevision: displayExisting?.syncRevision ?? committedExisting?.syncRevision,
      acceptedEventId: displayExisting?.acceptedEventId ?? committedExisting?.acceptedEventId,
      ignoredRemoteRevision: displayExisting?.ignoredRemoteRevision
        ?? committedExisting?.ignoredRemoteRevision,
    };

    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));
    try {
      const committed = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        progressData,
        bookmarkChanges,
        false,
        now,
      ));
      if (committed) rebaseProgressCommitBaseline(owner.ownerKey, bookId, progressData);
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
    const committedExisting = getCommittedProgress(owner, bookId);
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
      rebaseProgressCommitBaseline(owner.ownerKey, bookId, resetData);
      setProgress((prev) => ({ ...prev, [bookId]: resetData }));
      progressRef.current = { ...progressRef.current, [bookId]: resetData };
      return true;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  }, [getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress]);

  const deleteBookProgress = useCallback(async (
    bookId: string,
    owner: OwnerSnapshot,
  ) => {
    if (!ownerRuntime.isCurrent(owner)) return false;
    const existing = getCommittedProgress(owner, bookId);
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
    try {
      const committed = await queueProgressWrite(bookId, async () => {
        if (!ownerRuntime.isCurrent(owner)) return false;
        const progressOwnerKey = getSyncOwnerKey(owner.ownerKey);
        if (!user) {
          await removeProgressFromLocalV5(progressOwnerKey, bookId);
          return true;
        }
        const resetCommitted = await persistProgress(
          owner,
          bookId,
          resetData,
          bookmarkChanges,
          true,
        );
        if (!resetCommitted) return false;
        await removeProgressFromLocalV5(progressOwnerKey, bookId);
        return true;
      });
      if (!committed) return false;
      clearProgressCommitBaseline(owner.ownerKey, bookId);
      if (!ownerRuntime.isCurrent(owner)) return false;
      setProgress((prev) => {
        if (!ownerRuntime.isCurrent(owner)) return prev;
        const next = { ...prev };
        delete next[bookId];
        progressRef.current = next;
        return next;
      });
      return ownerRuntime.isCurrent(owner);
    } catch (error) {
      console.error('[DeleteBookProgress] outbox reset failed:', error);
      reportPersistenceError(error);
      return false;
    }
  }, [getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reportPersistenceError, setProgress, user]);

  const adoptRemoteProgress = useCallback(async (
    remote: RemoteProgressUpdate,
  ): Promise<RemoteProgressAdoptionResult> => {
    const owner = ownerRuntime.capture();
    if (
      !owner
      || !remote.bookId
      || (remote.operation === 'set' && !remote.cfi)
    ) return { status: 'cancelled' };
    const candidate: RemoteProgressUpdate = {
      ...remote,
      cfi: remote.operation === 'reset' ? '' : remote.cfi,
      anchorCfi: remote.operation === 'reset' ? '' : remote.anchorCfi || remote.cfi,
      progressPercent: remote.operation === 'reset' ? 0 : remote.progressPercent,
    };
    try {
      const result = await queueProgressWrite(remote.bookId, async () => {
        if (!ownerRuntime.isCurrent(owner)) {
          return { status: 'cancelled' } as RemoteProgressAdoptionResult;
        }
        return adoptRemoteProgressLocallyV5(
          getSyncOwnerKey(owner.ownerKey),
          candidate,
        );
      });
      if (result.status !== 'adopted') return result;
      if (!ownerRuntime.isCurrent(owner)) return { status: 'cancelled' };
      rebaseProgressCommitBaseline(owner.ownerKey, remote.bookId, result.progress);
      progressRef.current = { ...progressRef.current, [remote.bookId]: result.progress };
      setProgress((prev) => ownerRuntime.isCurrent(owner)
        ? { ...prev, [remote.bookId]: result.progress }
        : prev);
      return result;
    } catch (error) {
      reportPersistenceError(error);
      return { status: 'cancelled' };
    }
  }, [progressRef, queueProgressWrite, reportPersistenceError, setProgress]);

  const ignoreRemoteProgress = useCallback(async (bookId: string, revision: number) => {
    const owner = ownerRuntime.capture();
    if (!owner) return false;
    try {
      const ignored = await markRemoteProgressIgnoredV5(
        getSyncOwnerKey(owner.ownerKey),
        bookId,
        revision,
      );
      if (!ignored || !ownerRuntime.isCurrent(owner)) return false;
      setProgress((prev) => {
        const existing = prev[bookId];
        const nextProgress: UserProgress = {
          bookId,
          cfi: existing?.cfi ?? '',
          anchorCfi: existing?.anchorCfi ?? '',
          progressPercent: existing?.progressPercent ?? 0,
          lastRead: existing?.lastRead ?? 0,
          bookmarks: existing?.bookmarks ?? [],
          syncRevision: existing?.syncRevision,
          acceptedEventId: existing?.acceptedEventId,
          ignoredRemoteRevision: Math.max(existing?.ignoredRemoteRevision ?? 0, revision),
        };
        const next = { ...prev, [bookId]: nextProgress };
        progressRef.current = next;
        return next;
      });
      return true;
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
  }, [progressRef, reportPersistenceError, setProgress]);

  return {
    saveProgress,
    saveBookmarks,
    deleteProgress,
    deleteBookProgress,
    adoptRemoteProgress,
    ignoreRemoteProgress,
  };
};
