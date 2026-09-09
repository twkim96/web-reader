'use client';

import { useCallback, useEffect, useRef } from 'react';
import type {
  Bookmark,
  RemoteProgressAdoptionResult,
  RemoteProgressUpdate,
  SaveProgressOptions,
  UserProgress,
} from '../../types';
import {
  getBookmarksKey,
  isQuietReaderResumeEligible,
  isReaderProgressPersistenceSettled,
  startPendingReaderProgressCommitForTtsFence,
  toClampedPercent,
  updatePersistableReaderLocation,
} from './progress';
import type { PersistableReaderLocation, ReaderRelocateDetail } from './progress';
import type { RemoteProgressCommandFinalizeResult } from '../useSyncConflictResolution';
import type { RemoteProgressJumpCompletion } from './remoteProgressJump';
import { traceReaderBootstrap } from '../../lib/readerBootstrapTrace';

type SaveContext = {
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  bookmarks: Bookmark[];
  hasSyncConflict: boolean;
};

type RemoteProgressTarget = {
  bookId: string;
  cfi: string;
  anchorCfi?: string;
  percent: number;
  lastRead: number;
  syncRevision?: number;
  acceptedEventId?: string;
};

type PendingRelocateSave = {
  cfi: string;
  anchorCfi?: string;
  percent: number;
  bookmarks: Bookmark[];
};

type RemoteJumpPreparationSnapshot = {
  id: number;
  hasUnsavedUserChange: boolean;
  forceNextRelocateSave: boolean;
  pendingExpectedPercent: number | null;
  pendingBookmarks: Bookmark[] | null;
  pendingRelocateSave: PendingRelocateSave | null;
  unsavedSince: number | null;
};

export type ReaderRemoteNavigationAttempt = {
  id: number;
  interactionGeneration: number;
  signal: AbortSignal;
};

interface UseReaderProgressSaveOptions {
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => Promise<boolean>;
  onAdoptRemoteProgress: (
    progress: RemoteProgressUpdate,
    signal?: AbortSignal,
  ) => Promise<RemoteProgressAdoptionResult>;
}

const RELOCATE_SAVE_IDLE_MS = 1000;
const RELOCATE_SAVE_MAX_INTERVAL_MS = 5000;
const EXPLICIT_RELOCATE_SAVE_SETTLE_MS = 250;
const TTS_PROGRESS_FENCE_TAIL_MS = 350;

const traceReaderProgressRegression = (event: Record<string, unknown>) => {
  const regressionWindow = window as typeof window & {
    __readerProgressRegressionTrace?: Array<Record<string, unknown>>;
    __readerProgressRegressionPhase?: string;
  };
  if (!Array.isArray(regressionWindow.__readerProgressRegressionTrace)) return;
  regressionWindow.__readerProgressRegressionTrace.push({
    at: performance.now(),
    phase: regressionWindow.__readerProgressRegressionPhase ?? null,
    ...event,
  });
};

export const useReaderProgressSave = ({
  initialCfi,
  initialPercent,
  initialTime,
  initialBookmarks,
  onSaveProgress,
  onAdoptRemoteProgress,
}: UseReaderProgressSaveOptions) => {
  const provisionalRef = useRef<{
    original: PersistableReaderLocation;
    latest: PersistableReaderLocation;
    pending: RemoteJumpPreparationSnapshot;
    skipNextSave: boolean;
    commit: Promise<boolean> | null;
  } | null>(null);
  const lastSaveTimeRef = useRef(initialTime || 0);
  const skipNextSaveRef = useRef(true);
  const hasUserInteractedRef = useRef(false);
  const hasUnsavedUserChangeRef = useRef(false);
  const interactionGenerationRef = useRef(0);
  const inFlightCommitCountRef = useRef(0);
  const forceNextRelocateSaveRef = useRef(false);
  const pendingExpectedPercentRef = useRef<number | null>(null);
  const pendingBookmarksRef = useRef<Bookmark[] | null>(null);
  const pendingRelocateSaveRef = useRef<PendingRelocateSave | null>(null);
  const relocateSaveTimerRef = useRef<number | null>(null);
  const unsavedSinceRef = useRef<number | null>(null);
  const remoteJumpPreparationRef = useRef(0);
  const remoteJumpSnapshotRef = useRef<RemoteJumpPreparationSnapshot | null>(null);
  const remoteNavigationAttemptIdRef = useRef(0);
  const remoteNavigationAttemptRef = useRef<{
    id: number;
    interactionGeneration: number;
    controller: AbortController;
  } | null>(null);
  const ttsProgressFenceActiveRef = useRef(false);
  const ttsProgressFenceTailTimerRef = useRef<number | null>(null);
  const ttsFencePendingCommitRef = useRef<{
    generation: number;
    promise: Promise<boolean>;
  } | null>(null);
  const saveContextRef = useRef<SaveContext>({
    currentCfi: '',
    currentAnchorCfi: '',
    totalProgress: 0,
    bookmarks: initialBookmarks || [],
    hasSyncConflict: false,
  });
  const lastPersistedProgressRef = useRef({
    cfi: initialCfi || '',
    anchorCfi: initialCfi || '',
    percent: toClampedPercent(initialPercent) ?? 0,
    bookmarksKey: getBookmarksKey(initialBookmarks),
  });
  const lastPersistableLocationRef = useRef<PersistableReaderLocation>({
    cfi: initialCfi || '',
    anchorCfi: initialCfi || '',
    percent: toClampedPercent(initialPercent) ?? 0,
  });

  const updateSaveContext = useCallback((context: SaveContext) => {
    saveContextRef.current = context;
  }, []);

  const markUserInteraction = useCallback(() => {
    traceReaderProgressRegression({ event: 'user-interaction' });
    hasUserInteractedRef.current = true;
  }, []);

  const beginRemoteNavigationAttempt = useCallback((): ReaderRemoteNavigationAttempt => {
    remoteNavigationAttemptRef.current?.controller.abort();
    const controller = new AbortController();
    if (provisionalRef.current) controller.abort();
    remoteNavigationAttemptIdRef.current += 1;
    const attempt = {
      id: remoteNavigationAttemptIdRef.current,
      interactionGeneration: interactionGenerationRef.current,
      controller,
    };
    remoteNavigationAttemptRef.current = attempt;
    return {
      id: attempt.id,
      interactionGeneration: attempt.interactionGeneration,
      signal: controller.signal,
    };
  }, []);

  const isRemoteNavigationAttemptCurrent = useCallback((attempt: ReaderRemoteNavigationAttempt) => {
    const current = remoteNavigationAttemptRef.current;
    return Boolean(
      !provisionalRef.current
      && current
      && current.id === attempt.id
      && current.controller.signal === attempt.signal
      && !attempt.signal.aborted
      && interactionGenerationRef.current === attempt.interactionGeneration,
    );
  }, []);

  const finishRemoteNavigationAttempt = useCallback((attempt: ReaderRemoteNavigationAttempt) => {
    const current = remoteNavigationAttemptRef.current;
    if (current?.id === attempt.id && current.controller.signal === attempt.signal) {
      remoteNavigationAttemptRef.current = null;
    }
  }, []);

  const markUserProgressChange = useCallback((options?: {
    forceNextRelocateSave?: boolean;
    expectedPercent?: number;
    bookmarks?: Bookmark[];
  }) => {
    if (provisionalRef.current) {
      markUserInteraction();
      return;
    }
    if (ttsProgressFenceTailTimerRef.current !== null) {
      window.clearTimeout(ttsProgressFenceTailTimerRef.current);
      ttsProgressFenceTailTimerRef.current = null;
    }
    // Explicit user input releases the fence before its relocation arrives.
    ttsProgressFenceActiveRef.current = false;
    traceReaderProgressRegression({ event: 'user-change' });
    markUserInteraction();
    remoteNavigationAttemptRef.current?.controller.abort();
    remoteNavigationAttemptRef.current = null;
    hasUnsavedUserChangeRef.current = true;
    interactionGenerationRef.current += 1;
    if (options?.forceNextRelocateSave) {
      forceNextRelocateSaveRef.current = true;
    }
    const safeExpectedPercent = toClampedPercent(options?.expectedPercent);
    if (safeExpectedPercent !== null) {
      pendingExpectedPercentRef.current = safeExpectedPercent;
    }
    if (options?.bookmarks) {
      pendingBookmarksRef.current = options.bookmarks;
    }
  }, [markUserInteraction]);

  const clearRelocateSaveTimer = useCallback(() => {
    if (relocateSaveTimerRef.current === null) return;
    window.clearTimeout(relocateSaveTimerRef.current);
    relocateSaveTimerRef.current = null;
  }, []);

  const clearPendingSave = useCallback(() => {
    clearRelocateSaveTimer();
    hasUnsavedUserChangeRef.current = false;
    forceNextRelocateSaveRef.current = false;
    pendingExpectedPercentRef.current = null;
    pendingBookmarksRef.current = null;
    pendingRelocateSaveRef.current = null;
    unsavedSinceRef.current = null;
  }, [clearRelocateSaveTimer]);

  const commitProgressIfChanged = useCallback(async (
    cfi: string,
    pct: number,
    nextBookmarks: Bookmark[],
    options?: SaveProgressOptions
  ): Promise<boolean> => {
    traceReaderProgressRegression({
      event: 'save-attempt',
      cfi,
      force: Boolean(options?.force),
      fenceActive: ttsProgressFenceActiveRef.current,
      hasUnsavedUserChange: hasUnsavedUserChangeRef.current,
    });
    if (!options?.force && !hasUnsavedUserChangeRef.current) return false;

    const safePercent = toClampedPercent(pct);
    if (!cfi || safePercent === null) return false;

    const anchorCfi = options?.anchorCfi || cfi;
    const nextBookmarksKey = getBookmarksKey(nextBookmarks);
    const previous = lastPersistedProgressRef.current;
    const hasChanged = previous.cfi !== cfi ||
      previous.anchorCfi !== anchorCfi ||
      Math.abs(previous.percent - safePercent) >= 0.05 ||
      previous.bookmarksKey !== nextBookmarksKey;

    if (!options?.force && !hasChanged) {
      clearPendingSave();
      return false;
    }

    const saveGeneration = interactionGenerationRef.current;
    inFlightCommitCountRef.current += 1;
    let committed = false;
    try {
      committed = await onSaveProgress(cfi, safePercent, nextBookmarks, {
        ...(options?.force ? { force: true } : {}),
        anchorCfi,
        ...(options?.suppressLastReaderSession ? { suppressLastReaderSession: true } : {}),
      });
    } finally {
      inFlightCommitCountRef.current = Math.max(0, inFlightCommitCountRef.current - 1);
    }
    if (!committed) return false;

    lastPersistedProgressRef.current = {
      cfi,
      anchorCfi,
      percent: safePercent,
      bookmarksKey: nextBookmarksKey,
    };
    lastSaveTimeRef.current = Date.now();
    if (interactionGenerationRef.current === saveGeneration) {
      clearPendingSave();
    }
    return true;
  }, [clearPendingSave, onSaveProgress]);

  const saveProgressIfChanged = useCallback((
    cfi: string, pct: number, bookmarks: Bookmark[], options?: SaveProgressOptions,
  ) => {
    if (provisionalRef.current) return Promise.resolve(false);
    return commitProgressIfChanged(cfi, pct, bookmarks, options);
  }, [commitProgressIfChanged]);

  const savePendingRelocate = useCallback((options?: SaveProgressOptions) => {
    const pending = pendingRelocateSaveRef.current;
    if (!pending) return false;

    return saveProgressIfChanged(
      pending.cfi,
      pending.percent,
      pending.bookmarks,
      { ...options, anchorCfi: pending.anchorCfi }
    );
  }, [saveProgressIfChanged]);

  const setTtsProgressFenceActive = useCallback((active: boolean) => {
    if (ttsProgressFenceTailTimerRef.current !== null) {
      window.clearTimeout(ttsProgressFenceTailTimerRef.current);
      ttsProgressFenceTailTimerRef.current = null;
    }
    if (active) {
      clearRelocateSaveTimer();
      ttsProgressFenceActiveRef.current = true;
      const pending = pendingRelocateSaveRef.current;
      const generation = interactionGenerationRef.current;
      const existingCommit = ttsFencePendingCommitRef.current?.generation === generation
        ? ttsFencePendingCommitRef.current.promise
        : null;
      const commit = startPendingReaderProgressCommitForTtsFence(
        pending,
        existingCommit,
        (snapshot) => saveProgressIfChanged(
          snapshot.cfi,
          snapshot.percent,
          snapshot.bookmarks,
          { anchorCfi: snapshot.anchorCfi },
        ),
      );
      if (commit && commit !== existingCommit) {
        ttsFencePendingCommitRef.current = { generation, promise: commit };
        const clearCommit = () => {
          if (ttsFencePendingCommitRef.current?.promise === commit) {
            ttsFencePendingCommitRef.current = null;
          }
        };
        void commit.then(clearCommit, clearCommit);
      }
      traceReaderProgressRegression({
        event: 'tts-fence',
        active: true,
        pendingUserLocation: Boolean(pending),
      });
      return;
    }
    // Foliate may emit one last anchor/page relocate after transient
    // navigation cancellation. Explicit input can release this tail early.
    ttsProgressFenceTailTimerRef.current = window.setTimeout(() => {
      ttsProgressFenceTailTimerRef.current = null;
      ttsProgressFenceActiveRef.current = false;
      traceReaderProgressRegression({ event: 'tts-fence-tail-released' });
    }, TTS_PROGRESS_FENCE_TAIL_MS);
    traceReaderProgressRegression({ event: 'tts-fence-tail-started' });
  }, [clearRelocateSaveTimer, saveProgressIfChanged]);

  const scheduleRelocateSave = useCallback((pending: PendingRelocateSave, options?: {
    delayMs?: number;
    useMaxInterval?: boolean;
  }) => {
    traceReaderProgressRegression({
      event: 'relocate-save-scheduled',
      cfi: pending.cfi,
      fenceActive: ttsProgressFenceActiveRef.current,
    });
    pendingRelocateSaveRef.current = pending;

    const now = Date.now();
    if (!unsavedSinceRef.current) {
      unsavedSinceRef.current = now;
    }

    if (options?.useMaxInterval !== false && now - unsavedSinceRef.current >= RELOCATE_SAVE_MAX_INTERVAL_MS) {
      clearRelocateSaveTimer();
      void saveProgressIfChanged(pending.cfi, pending.percent, pending.bookmarks);
      return;
    }

    clearRelocateSaveTimer();
    relocateSaveTimerRef.current = window.setTimeout(() => {
      relocateSaveTimerRef.current = null;
      void savePendingRelocate();
    }, options?.delayMs ?? RELOCATE_SAVE_IDLE_MS);
  }, [clearRelocateSaveTimer, savePendingRelocate, saveProgressIfChanged]);

  const handleRelocateForSave = useCallback((detail: ReaderRelocateDetail) => {
    traceReaderBootstrap({
      event: 'relocate',
      status: detail.reason ?? detail.navigationSource ?? undefined,
      page: Number.isFinite(detail.location?.current) ? detail.location?.current : undefined,
      pages: Number.isFinite(detail.location?.total) ? detail.location?.total : undefined,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    traceReaderProgressRegression({
      event: 'relocate',
      reason: detail.reason ?? null,
      navigationSource: detail.navigationSource ?? null,
      cfi: detail.cfi ?? null,
      fenceActive: ttsProgressFenceActiveRef.current,
    });
    const { totalProgress, bookmarks, hasSyncConflict } = saveContextRef.current;
    const provisional = provisionalRef.current;
    if (provisional) {
      provisional.latest = updatePersistableReaderLocation(
        provisional.latest, detail, totalProgress, false,
      );
      return;
    }
    const fallbackPercent = pendingExpectedPercentRef.current ?? totalProgress;
    const previousPersistableLocation = lastPersistableLocationRef.current;
    const persistableLocation = updatePersistableReaderLocation(
      previousPersistableLocation,
      detail,
      fallbackPercent,
      ttsProgressFenceActiveRef.current,
    );
    if (persistableLocation === previousPersistableLocation) return;
    lastPersistableLocationRef.current = persistableLocation;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    if (!hasUnsavedUserChangeRef.current) return;

    if (hasSyncConflict) return;

    const pending = {
      ...persistableLocation,
      bookmarks: pendingBookmarksRef.current || bookmarks,
    };

    if (forceNextRelocateSaveRef.current) {
      scheduleRelocateSave(pending, {
        delayMs: EXPLICIT_RELOCATE_SAVE_SETTLE_MS,
        useMaxInterval: false,
      });
      return;
    }

    scheduleRelocateSave(pending);
  }, [scheduleRelocateSave]);

  const saveCurrentProgress = useCallback((options?: SaveProgressOptions) => {
    if (provisionalRef.current) return false;
    traceReaderProgressRegression({
      event: 'save-current',
      force: Boolean(options?.force),
      fenceActive: ttsProgressFenceActiveRef.current,
      hasPendingRelocateSave: pendingRelocateSaveRef.current !== null,
    });
    const { bookmarks } = saveContextRef.current;
    const { cfi, anchorCfi, percent } = lastPersistableLocationRef.current;
    if (!cfi) return false;
    clearRelocateSaveTimer();
    if (pendingRelocateSaveRef.current) {
      return savePendingRelocate(options);
    }
    if (ttsProgressFenceActiveRef.current) return false;
    return saveProgressIfChanged(
      cfi,
      percent,
      pendingBookmarksRef.current || bookmarks,
      { ...options, anchorCfi }
    );
  }, [clearRelocateSaveTimer, savePendingRelocate, saveProgressIfChanged]);

  const beginProvisionalNavigation = useCallback(() => {
    if (provisionalRef.current) return;
    clearRelocateSaveTimer();
    remoteNavigationAttemptRef.current?.controller.abort();
    remoteNavigationAttemptRef.current = null;
    provisionalRef.current = {
      original: { ...lastPersistableLocationRef.current },
      latest: { ...lastPersistableLocationRef.current },
      skipNextSave: skipNextSaveRef.current,
      pending: {
        id: 0,
        hasUnsavedUserChange: hasUnsavedUserChangeRef.current,
        forceNextRelocateSave: forceNextRelocateSaveRef.current,
        pendingExpectedPercent: pendingExpectedPercentRef.current,
        pendingBookmarks: pendingBookmarksRef.current,
        pendingRelocateSave: pendingRelocateSaveRef.current,
        unsavedSince: unsavedSinceRef.current,
      },
      commit: null,
    };
    // An older commit may finish while previewing; it must not clear this session.
    interactionGenerationRef.current += 1;
    clearPendingSave();
  }, [clearPendingSave, clearRelocateSaveTimer]);

  const confirmProvisionalNavigation = useCallback((bookmarks?: Bookmark[]): Promise<boolean> => {
    const transaction = provisionalRef.current;
    if (!transaction) return Promise.resolve(false);
    if (transaction.commit) return transaction.commit;
    if (saveContextRef.current.hasSyncConflict) return Promise.resolve(false);
    const location = { ...transaction.latest };
    const commit = commitProgressIfChanged(
      location.cfi, location.percent,
      bookmarks ?? saveContextRef.current.bookmarks,
      { force: true, anchorCfi: location.anchorCfi },
    ).then((committed) => {
      if (committed && provisionalRef.current === transaction) {
        lastPersistableLocationRef.current = location;
        provisionalRef.current = null;
        skipNextSaveRef.current = false;
        clearPendingSave();
      }
      return committed;
    }).finally(() => {
      transaction.commit = null;
    });
    transaction.commit = commit;
    return commit;
  }, [clearPendingSave, commitProgressIfChanged]);

  const cancelProvisionalNavigation = useCallback(() => {
    const transaction = provisionalRef.current;
    if (!transaction || transaction.commit) return;
    const snapshot = transaction.pending;
    lastPersistableLocationRef.current = transaction.original;
    provisionalRef.current = null;
    skipNextSaveRef.current = transaction.skipNextSave;
    hasUnsavedUserChangeRef.current = snapshot.hasUnsavedUserChange;
    forceNextRelocateSaveRef.current = snapshot.forceNextRelocateSave;
    pendingExpectedPercentRef.current = snapshot.pendingExpectedPercent;
    pendingBookmarksRef.current = snapshot.pendingBookmarks;
    pendingRelocateSaveRef.current = snapshot.pendingRelocateSave;
    unsavedSinceRef.current = snapshot.unsavedSince;
    if (snapshot.pendingRelocateSave) {
      scheduleRelocateSave(snapshot.pendingRelocateSave);
    }
  }, [scheduleRelocateSave]);

  const isProvisionalNavigationActive = useCallback(() => provisionalRef.current !== null, []);

  const prepareRemoteJump = useCallback(() => {
    if (provisionalRef.current) return -1;
    remoteJumpPreparationRef.current += 1;
    remoteJumpSnapshotRef.current = {
      id: remoteJumpPreparationRef.current,
      hasUnsavedUserChange: hasUnsavedUserChangeRef.current,
      forceNextRelocateSave: forceNextRelocateSaveRef.current,
      pendingExpectedPercent: pendingExpectedPercentRef.current,
      pendingBookmarks: pendingBookmarksRef.current,
      pendingRelocateSave: pendingRelocateSaveRef.current,
      unsavedSince: unsavedSinceRef.current,
    };
    skipNextSaveRef.current = true;
    clearPendingSave();
    return remoteJumpPreparationRef.current;
  }, [clearPendingSave]);

  const prepareRemoteRollback = useCallback((preparationId: number) => {
    if (remoteJumpSnapshotRef.current?.id !== preparationId) return false;
    skipNextSaveRef.current = true;
    return true;
  }, []);

  const cancelRemoteJump = useCallback((preparationId: number) => {
    const snapshot = remoteJumpSnapshotRef.current;
    if (remoteJumpPreparationRef.current !== preparationId || snapshot?.id !== preparationId) return;
    remoteJumpSnapshotRef.current = null;
    skipNextSaveRef.current = false;
    if (!hasUnsavedUserChangeRef.current) {
      hasUnsavedUserChangeRef.current = snapshot.hasUnsavedUserChange;
      forceNextRelocateSaveRef.current = snapshot.forceNextRelocateSave;
      pendingExpectedPercentRef.current = snapshot.pendingExpectedPercent;
      pendingBookmarksRef.current = snapshot.pendingBookmarks;
      pendingRelocateSaveRef.current = snapshot.pendingRelocateSave;
      unsavedSinceRef.current = snapshot.unsavedSince;
      if (snapshot.pendingRelocateSave) {
        scheduleRelocateSave(snapshot.pendingRelocateSave, {
          delayMs: EXPLICIT_RELOCATE_SAVE_SETTLE_MS,
          useMaxInterval: false,
        });
      }
      return;
    }
    const { cfi, anchorCfi, percent } = lastPersistableLocationRef.current;
    if (!cfi) return;
    scheduleRelocateSave({
      cfi,
      anchorCfi,
      percent,
      bookmarks: pendingBookmarksRef.current ?? saveContextRef.current.bookmarks,
    }, { delayMs: EXPLICIT_RELOCATE_SAVE_SETTLE_MS, useMaxInterval: false });
  }, [scheduleRelocateSave]);

  const finishRemoteJump = useCallback((preparationId: number) => {
    if (remoteJumpSnapshotRef.current?.id !== preparationId) return;
    remoteJumpSnapshotRef.current = null;
    skipNextSaveRef.current = false;
  }, []);

  const getPersistenceState = useCallback(() => ({
    hasUnsavedUserChange: Boolean(provisionalRef.current) || hasUnsavedUserChangeRef.current,
    hasPendingRelocateSave: pendingRelocateSaveRef.current !== null,
    inFlightCommitCount: inFlightCommitCountRef.current,
  }), []);

  const isQuietResumeEligible = useCallback(() => isQuietReaderResumeEligible({
    ...getPersistenceState(),
    hasUserInteracted: hasUserInteractedRef.current,
  }), [getPersistenceState]);

  const isProgressConflictAutoResolveEligible = useCallback(() => (
    isReaderProgressPersistenceSettled(getPersistenceState())
  ), [getPersistenceState]);

  const flushCurrentProgress = useCallback(async () => {
    if (provisionalRef.current) return false;
    if (
      ttsProgressFenceActiveRef.current
      && !pendingRelocateSaveRef.current
    ) {
      return isReaderProgressPersistenceSettled({
        hasUnsavedUserChange: hasUnsavedUserChangeRef.current,
        hasPendingRelocateSave: false,
        inFlightCommitCount: inFlightCommitCountRef.current,
      });
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = interactionGenerationRef.current;
      const committed = await saveCurrentProgress({ force: true });
      if (!committed) return false;
      if (
        interactionGenerationRef.current === generation
        && !hasUnsavedUserChangeRef.current
        && !pendingRelocateSaveRef.current
        && inFlightCommitCountRef.current === 0
      ) return true;
    }
    return false;
  }, [saveCurrentProgress]);

  useEffect(() => () => {
    clearRelocateSaveTimer();
    remoteNavigationAttemptRef.current?.controller.abort();
    remoteNavigationAttemptRef.current = null;
    if (ttsProgressFenceTailTimerRef.current !== null) {
      window.clearTimeout(ttsProgressFenceTailTimerRef.current);
    }
  }, [clearRelocateSaveTimer]);

  const applyCanonicalRemoteProgress = useCallback((progress: UserProgress) => {
    if (provisionalRef.current) return;
    const safePercent = toClampedPercent(progress.progressPercent) ?? 0;
    const cfi = progress.cfi || '';
    const anchorCfi = progress.anchorCfi || cfi;
    lastSaveTimeRef.current = progress.lastRead;
    lastPersistedProgressRef.current = {
      cfi,
      anchorCfi,
      percent: safePercent,
      bookmarksKey: getBookmarksKey(progress.bookmarks),
    };
    lastPersistableLocationRef.current = {
      cfi,
      anchorCfi,
      percent: safePercent,
    };
    clearPendingSave();
    skipNextSaveRef.current = false;
  }, [clearPendingSave]);

  const adoptRemoteProgressBeforeNavigation = useCallback(async (
    remote: RemoteProgressUpdate,
    signal?: AbortSignal,
  ): Promise<RemoteProgressAdoptionResult> => {
    if (provisionalRef.current) return { status: 'cancelled' };
    const result = await onAdoptRemoteProgress(remote, signal);
    if (result.status === 'adopted') applyCanonicalRemoteProgress(result.progress);
    return result;
  }, [applyCanonicalRemoteProgress, onAdoptRemoteProgress]);

  const completeRemoteJump = useCallback(async (
    target: RemoteProgressTarget,
    bookmarks: Bookmark[],
    options?: {
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
      signal?: AbortSignal;
    }
  ): Promise<RemoteProgressJumpCompletion> => {
    if (provisionalRef.current) return false;
    let canonicalProgress: UserProgress;
    if (options?.finalize) {
      const result = await options.finalize();
      if (result.status !== 'committed') {
        return result.status === 'stale'
          ? { completed: false, afterRollback: result.restart }
          : false;
      }
      canonicalProgress = result.progress;
    } else {
      const adoption = await onAdoptRemoteProgress({
        operation: 'set',
        bookId: target.bookId,
        cfi: target.cfi,
        anchorCfi: target.anchorCfi || target.cfi,
        progressPercent: toClampedPercent(target.percent) ?? 0,
        lastRead: target.lastRead,
        bookmarks,
        syncRevision: target.syncRevision,
        acceptedEventId: target.acceptedEventId,
      }, options?.signal);
      if (adoption.status !== 'adopted') return false;
      canonicalProgress = adoption.progress;
    }
    applyCanonicalRemoteProgress(canonicalProgress);
    return true;
  }, [applyCanonicalRemoteProgress, onAdoptRemoteProgress]);

  const completeRemoteReset = useCallback(async (
    target: Omit<RemoteProgressTarget, 'cfi' | 'anchorCfi' | 'percent'>,
    bookmarks: Bookmark[],
    options?: {
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
      signal?: AbortSignal;
    },
  ): Promise<RemoteProgressJumpCompletion> => {
    if (provisionalRef.current) return false;
    let canonicalProgress: UserProgress;
    if (options?.finalize) {
      const result = await options.finalize();
      if (result.status !== 'committed') {
        return result.status === 'stale'
          ? { completed: false, afterRollback: result.restart }
          : false;
      }
      canonicalProgress = result.progress;
    } else {
      const adoption = await onAdoptRemoteProgress({
        operation: 'reset',
        bookId: target.bookId,
        cfi: '',
        anchorCfi: '',
        progressPercent: 0,
        lastRead: target.lastRead,
        bookmarks,
        syncRevision: target.syncRevision,
        acceptedEventId: target.acceptedEventId,
      }, options?.signal);
      if (adoption.status !== 'adopted') return false;
      canonicalProgress = adoption.progress;
    }
    applyCanonicalRemoteProgress(canonicalProgress);
    return true;
  }, [applyCanonicalRemoteProgress, onAdoptRemoteProgress]);

  return {
    beginProvisionalNavigation,
    confirmProvisionalNavigation,
    cancelProvisionalNavigation,
    isProvisionalNavigationActive,
    lastSaveTimeRef,
    updateSaveContext,
    markUserInteraction,
    markUserProgressChange,
    setTtsProgressFenceActive,
    saveProgressIfChanged,
    handleRelocateForSave,
    saveCurrentProgress,
    flushCurrentProgress,
    prepareRemoteJump,
    prepareRemoteRollback,
    cancelRemoteJump,
    finishRemoteJump,
    beginRemoteNavigationAttempt,
    isRemoteNavigationAttemptCurrent,
    finishRemoteNavigationAttempt,
    isQuietResumeEligible,
    isProgressConflictAutoResolveEligible,
    adoptRemoteProgressBeforeNavigation,
    completeRemoteJump,
    completeRemoteReset,
  };
};
