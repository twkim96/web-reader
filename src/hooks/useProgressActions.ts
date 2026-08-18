import { Dispatch, MutableRefObject, SetStateAction, useCallback, useEffect, useRef } from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import {
  loadProgressFromLocalV5,
  removeProgressFromLocalV5,
  saveProgressToLocalV5,
} from '../lib/localDBV5';
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
import {
  applyManualBookmarkMutation,
  diffManualBookmarks,
  manualBookmarkMutationToSyncChange,
  type BookmarkSyncChange,
  type ManualBookmarkMutation,
} from '../lib/bookmarkSyncPolicy';
import { trackLocalCommit } from '../lib/localCommitTracker';
import { getSyncOwnerKey } from '../lib/ownerIdentity';
import {
  clearProgressCommitBaseline,
  getProgressCommitBaseline,
  rebaseProgressCommitBaseline,
} from '../lib/progressCommitBaseline';
import { getSyncSessionId } from '../lib/syncSession';
import {
  canApplyReloadedProgress,
  getProgressCommitConvergenceAction,
  type ProgressCommitConvergenceOutcome,
} from '../lib/progressCommitConvergence';

const DEFAULT_PROGRESS_CONVERGENCE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

interface UseProgressActionsOptions {
  activeBook: Book | null;
  user: FirebaseUser | null;
  deviceId: MutableRefObject<string>;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  onPersistenceError?: (message: string) => void;
  loadProgressForConvergence?: typeof loadProgressFromLocalV5;
  convergenceRetryDelaysMs?: readonly number[];
}

export const useProgressActions = ({
  activeBook,
  user,
  deviceId,
  progressRef,
  setProgress,
  onPersistenceError,
  loadProgressForConvergence = loadProgressFromLocalV5,
  convergenceRetryDelaysMs = DEFAULT_PROGRESS_CONVERGENCE_RETRY_DELAYS_MS,
}: UseProgressActionsOptions) => {
  const writeTailsRef = useRef(new Map<string, Promise<unknown>>());
  const localWriteGenerationsRef = useRef(new Map<string, number>());
  const convergenceTimersRef = useRef(new Map<string, number>());
  const convergenceActiveRef = useRef(false);
  const sessionIdRef = useRef(getSyncSessionId());

  useEffect(() => {
    convergenceActiveRef.current = true;
    const convergenceTimers = convergenceTimersRef.current;
    return () => {
      convergenceActiveRef.current = false;
      for (const timer of convergenceTimers.values()) {
        window.clearTimeout(timer);
      }
      convergenceTimers.clear();
    };
  }, []);

  const beginLocalWrite = useCallback((bookId: string) => {
    const next = (localWriteGenerationsRef.current.get(bookId) ?? 0) + 1;
    localWriteGenerationsRef.current.set(bookId, next);
    return next;
  }, []);

  const isLatestLocalWrite = useCallback((bookId: string, generation: number) => (
    localWriteGenerationsRef.current.get(bookId) === generation
  ), []);

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
    if (!ownerRuntime.isCurrent(owner)) return null;
    const progressOwnerKey = getSyncOwnerKey(owner.ownerKey);
    if (!user) {
      await saveProgressToLocalV5(progressOwnerKey, progressData);
      return progressData;
    }
    return enqueueProgressMutationBatchV5(progressOwnerKey, {
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
  }, [deviceId, user]);

  const convergeCommittedProgress = useCallback(async (
    owner: OwnerSnapshot,
    bookId: string,
    optimistic: UserProgress,
    canonical: UserProgress,
    generation: number,
  ): Promise<ProgressCommitConvergenceOutcome> => {
    rebaseProgressCommitBaseline(owner.ownerKey, bookId, canonical);
    const observedDisplay = progressRef.current[bookId];
    const convergenceAction = getProgressCommitConvergenceAction({
      ownerCurrent: convergenceActiveRef.current && ownerRuntime.isCurrent(owner),
      latestLocalWrite: isLatestLocalWrite(bookId, generation),
      currentDisplay: observedDisplay,
      optimistic,
    });
    if (convergenceAction === 'skip') return 'superseded';

    let settled = canonical;
    if (convergenceAction === 'reload-persisted') {
      let persisted: UserProgress | undefined;
      try {
        persisted = await loadProgressForConvergence(
          getSyncOwnerKey(owner.ownerKey),
          bookId,
        );
      } catch (error) {
        console.warn('[ProgressConvergence] canonical reload deferred:', error);
        return 'deferred';
      }
      if (!persisted) {
        console.warn('[ProgressConvergence] canonical reload returned no progress; deferring reconciliation.');
        return 'deferred';
      }
      if (!canApplyReloadedProgress({
        ownerCurrent: convergenceActiveRef.current && ownerRuntime.isCurrent(owner),
        latestLocalWrite: isLatestLocalWrite(bookId, generation),
        currentDisplay: progressRef.current[bookId],
        observedDisplay,
      })) return 'superseded';
      settled = persisted;
      rebaseProgressCommitBaseline(owner.ownerKey, bookId, settled);
    }

    if (
      !convergenceActiveRef.current
      || !ownerRuntime.isCurrent(owner)
      || !isLatestLocalWrite(bookId, generation)
    ) return 'superseded';
    setProgress((prev) => {
      if (
        !convergenceActiveRef.current
        || !ownerRuntime.isCurrent(owner)
        || !isLatestLocalWrite(bookId, generation)
      ) return prev;
      const current = prev[bookId];
      const currentRef = progressRef.current[bookId];
      if (
        (current !== observedDisplay && current !== optimistic)
        || (currentRef !== observedDisplay && currentRef !== optimistic)
      ) return prev;
      progressRef.current = { ...progressRef.current, [bookId]: settled };
      return { ...prev, [bookId]: settled };
    });
    return 'applied';
  }, [isLatestLocalWrite, loadProgressForConvergence, progressRef, setProgress]);

  const scheduleCanonicalProgressReconciliation = useCallback((
    owner: OwnerSnapshot,
    bookId: string,
    generation: number,
  ) => {
    const existingTimer = convergenceTimersRef.current.get(bookId);
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);

    let attempt = 0;
    const scheduleNext = () => {
      if (
        !convergenceActiveRef.current
        || !ownerRuntime.isCurrent(owner)
        || !isLatestLocalWrite(bookId, generation)
      ) {
        convergenceTimersRef.current.delete(bookId);
        return;
      }
      const delay = convergenceRetryDelaysMs[attempt];
      if (delay === undefined) {
        convergenceTimersRef.current.delete(bookId);
        console.warn('[ProgressConvergence] deferred reconciliation exhausted retries.');
        return;
      }
      attempt += 1;
      const timer = window.setTimeout(() => {
        if (convergenceTimersRef.current.get(bookId) !== timer) return;
        convergenceTimersRef.current.delete(bookId);
        void (async () => {
          try {
            const persisted = await loadProgressForConvergence(
              getSyncOwnerKey(owner.ownerKey),
              bookId,
            );
            if (!persisted) {
              console.warn('[ProgressConvergence] deferred canonical read returned no progress.');
              scheduleNext();
              return;
            }
            if (
              !convergenceActiveRef.current
              || !ownerRuntime.isCurrent(owner)
              || !isLatestLocalWrite(bookId, generation)
            ) return;

            const observedDisplay = progressRef.current[bookId];
            rebaseProgressCommitBaseline(owner.ownerKey, bookId, persisted);
            setProgress((prev) => {
              if (
                !convergenceActiveRef.current
                || !ownerRuntime.isCurrent(owner)
                || !isLatestLocalWrite(bookId, generation)
              ) return prev;
              if (
                progressRef.current[bookId] !== observedDisplay
                || prev[bookId] !== observedDisplay
              ) return prev;
              progressRef.current = { ...progressRef.current, [bookId]: persisted };
              return { ...prev, [bookId]: persisted };
            });
          } catch (error) {
            console.warn('[ProgressConvergence] deferred reconciliation failed:', error);
            scheduleNext();
          }
        })();
      }, Math.max(0, delay));
      convergenceTimersRef.current.set(bookId, timer);
    };

    scheduleNext();
  }, [convergenceRetryDelaysMs, isLatestLocalWrite, loadProgressForConvergence, progressRef, setProgress]);

  const reconcileDurableProgressCommit = useCallback(async (
    owner: OwnerSnapshot,
    bookId: string,
    optimistic: UserProgress,
    canonical: UserProgress,
    generation: number,
  ) => {
    let outcome: ProgressCommitConvergenceOutcome;
    try {
      outcome = await convergeCommittedProgress(
        owner,
        bookId,
        optimistic,
        canonical,
        generation,
      );
    } catch (error) {
      console.warn('[ProgressConvergence] immediate reconciliation deferred:', error);
      outcome = 'deferred';
    }
    if (outcome === 'deferred') {
      scheduleCanonicalProgressReconciliation(owner, bookId, generation);
    }
  }, [convergeCommittedProgress, scheduleCanonicalProgressReconciliation]);

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
    const currentBookmarks = displayExisting?.bookmarks ?? committedBookmarks;
    // Position saves do not own manual bookmark intent. A delayed relocate may
    // carry a stale bookmark snapshot, so preserve the latest manual set and
    // only take local-only auto bookmarks from the captured relocate payload.
    const currentManualBookmarks = currentBookmarks.filter((bookmark) => bookmark.type === 'manual');
    const requestedAutoBookmarks = bookmarks !== undefined
      ? bookmarks.filter((bookmark) => bookmark.type === 'auto')
      : currentBookmarks.filter((bookmark) => bookmark.type === 'auto');
    const finalBookmarks = [...currentManualBookmarks, ...requestedAutoBookmarks];
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
    const bookmarkChanges: BookmarkSyncChange[] = [];
    const syncPosition = Boolean(
      options?.force
      || !committedExisting
      || committedExisting.cfi !== nextCfi
      || (committedExisting.anchorCfi ?? committedExisting.cfi) !== nextAnchorCfi
      || committedPercent !== safePercent,
    );

    const generation = beginLocalWrite(bookId);
    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));

    let canonical: UserProgress | null;
    try {
      canonical = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        progressData,
        bookmarkChanges,
        syncPosition,
      ));
    } catch (error) {
      reportPersistenceError(error);
      return false;
    }
    if (!canonical) return false;

    rebaseProgressCommitBaseline(owner.ownerKey, bookId, canonical);
    if (!ownerRuntime.isCurrent(owner)) return true;
    await reconcileDurableProgressCommit(owner, bookId, progressData, canonical, generation);
    return true;
  }, [activeBook, beginLocalWrite, getCommittedProgress, persistProgress, progressRef, queueProgressWrite, reconcileDurableProgressCommit, reportPersistenceError, setProgress]);

  const saveBookmarkMutation = useCallback(async (
    bookId: string,
    mutation: ManualBookmarkMutation,
  ) => {
    if (!activeBook || activeBook.id !== bookId) return false;
    const owner = ownerRuntime.capture();
    if (!owner) return false;

    const displayExisting = progressRef.current[bookId];
    const committedExisting = getCommittedProgress(owner, bookId);
    const previousBookmarks = displayExisting?.bookmarks ?? committedExisting?.bookmarks ?? [];
    const now = Date.now();
    const nextBookmarks = applyManualBookmarkMutation(previousBookmarks, mutation);
    const bookmarkChanges = [manualBookmarkMutationToSyncChange(mutation, now)];

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
      bookmarks: nextBookmarks,
      syncRevision: displayExisting?.syncRevision ?? committedExisting?.syncRevision,
      acceptedEventId: displayExisting?.acceptedEventId ?? committedExisting?.acceptedEventId,
      ignoredRemoteRevision: displayExisting?.ignoredRemoteRevision
        ?? committedExisting?.ignoredRemoteRevision,
    };

    const generation = beginLocalWrite(bookId);
    progressRef.current = { ...progressRef.current, [bookId]: progressData };
    setProgress((prev) => ({ ...prev, [bookId]: progressData }));

    let canonical: UserProgress | null;
    try {
      canonical = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        progressData,
        bookmarkChanges,
        false,
        now,
      ));
    } catch (error) {
      reportPersistenceError(error);
      const rollback = getCommittedProgress(owner, bookId) ?? committedExisting ?? displayExisting;
      if (
        ownerRuntime.isCurrent(owner)
        && isLatestLocalWrite(bookId, generation)
        && progressRef.current[bookId] === progressData
      ) {
        if (rollback) {
          progressRef.current = { ...progressRef.current, [bookId]: rollback };
          setProgress((prev) => (
            prev[bookId] === progressData ? { ...prev, [bookId]: rollback } : prev
          ));
        } else {
          const next = { ...progressRef.current };
          delete next[bookId];
          progressRef.current = next;
          setProgress((prev) => {
            if (prev[bookId] !== progressData) return prev;
            const restored = { ...prev };
            delete restored[bookId];
            return restored;
          });
        }
      }
      return false;
    }
    if (!canonical) return false;

    rebaseProgressCommitBaseline(owner.ownerKey, bookId, canonical);
    if (!ownerRuntime.isCurrent(owner)) return true;
    await reconcileDurableProgressCommit(owner, bookId, progressData, canonical, generation);
    return true;
  }, [activeBook, beginLocalWrite, getCommittedProgress, isLatestLocalWrite, persistProgress, progressRef, queueProgressWrite, reconcileDurableProgressCommit, reportPersistenceError, setProgress]);

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
      const canonical = await queueProgressWrite(bookId, () => persistProgress(
        owner,
        bookId,
        resetData,
        bookmarkChanges,
        true,
      ));
      if (!canonical) return false;
      rebaseProgressCommitBaseline(owner.ownerKey, bookId, canonical);
      setProgress((prev) => ({ ...prev, [bookId]: canonical }));
      progressRef.current = { ...progressRef.current, [bookId]: canonical };
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
    signal?: AbortSignal,
  ): Promise<RemoteProgressAdoptionResult> => {
    const owner = ownerRuntime.capture();
    if (
      !owner
      || !remote.bookId
      || (remote.operation === 'set' && !remote.cfi)
    ) return { status: 'cancelled' };
    if (signal?.aborted) return { status: 'cancelled' };
    const candidate: RemoteProgressUpdate = {
      ...remote,
      cfi: remote.operation === 'reset' ? '' : remote.cfi,
      anchorCfi: remote.operation === 'reset' ? '' : remote.anchorCfi || remote.cfi,
      progressPercent: remote.operation === 'reset' ? 0 : remote.progressPercent,
    };
    try {
      const result = await queueProgressWrite(remote.bookId, async () => {
        if (!ownerRuntime.isCurrent(owner) || signal?.aborted) {
          return { status: 'cancelled' } as RemoteProgressAdoptionResult;
        }
        return adoptRemoteProgressLocallyV5(
          getSyncOwnerKey(owner.ownerKey),
          candidate,
          Date.now(),
          signal,
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
    saveBookmarkMutation,
    deleteProgress,
    deleteBookProgress,
    adoptRemoteProgress,
    ignoreRemoteProgress,
  };
};
