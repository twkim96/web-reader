'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Bookmark, RemoteProgressUpdate, SaveProgressOptions } from '../../types';
import {
  getBookmarksKey,
  isQuietReaderResumeEligible,
  isReaderProgressPersistenceSettled,
  toClampedPercent,
  updatePersistableReaderLocation,
} from './progress';
import type { PersistableReaderLocation, ReaderRelocateDetail } from './progress';

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

interface UseReaderProgressSaveOptions {
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => Promise<boolean>;
  onAdoptRemoteProgress: (progress: RemoteProgressUpdate) => Promise<boolean>;
}

const RELOCATE_SAVE_IDLE_MS = 1000;
const RELOCATE_SAVE_MAX_INTERVAL_MS = 5000;
const EXPLICIT_RELOCATE_SAVE_SETTLE_MS = 250;

export const useReaderProgressSave = ({
  initialCfi,
  initialPercent,
  initialTime,
  initialBookmarks,
  onSaveProgress,
  onAdoptRemoteProgress,
}: UseReaderProgressSaveOptions) => {
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

  const markUserProgressChange = useCallback((options?: {
    forceNextRelocateSave?: boolean;
    expectedPercent?: number;
    bookmarks?: Bookmark[];
  }) => {
    hasUserInteractedRef.current = true;
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
  }, []);

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

  const saveProgressIfChanged = useCallback(async (
    cfi: string,
    pct: number,
    nextBookmarks: Bookmark[],
    options?: SaveProgressOptions
  ) => {
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

  const scheduleRelocateSave = useCallback((pending: PendingRelocateSave, options?: {
    delayMs?: number;
    useMaxInterval?: boolean;
  }) => {
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
    const { totalProgress, bookmarks, hasSyncConflict } = saveContextRef.current;
    const fallbackPercent = pendingExpectedPercentRef.current ?? totalProgress;
    const previousPersistableLocation = lastPersistableLocationRef.current;
    const persistableLocation = updatePersistableReaderLocation(
      previousPersistableLocation,
      detail,
      fallbackPercent,
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
    const { bookmarks } = saveContextRef.current;
    const { cfi, anchorCfi, percent } = lastPersistableLocationRef.current;
    if (!cfi) return false;
    clearRelocateSaveTimer();
    if (pendingRelocateSaveRef.current) {
      return savePendingRelocate(options);
    }
    return saveProgressIfChanged(
      cfi,
      percent,
      pendingBookmarksRef.current || bookmarks,
      { ...options, anchorCfi }
    );
  }, [clearRelocateSaveTimer, savePendingRelocate, saveProgressIfChanged]);

  const prepareRemoteJump = useCallback(() => {
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
    hasUnsavedUserChange: hasUnsavedUserChangeRef.current,
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
  }, [clearRelocateSaveTimer]);

  const completeRemoteJump = useCallback(async (
    target: RemoteProgressTarget,
    bookmarks: Bookmark[],
    options?: { claimDevice?: boolean; finalize?: () => Promise<boolean> }
  ) => {
    const safePercent = toClampedPercent(target.percent) ?? 0;
    const bookmarksKey = getBookmarksKey(bookmarks);

    if (options?.finalize) {
      const committed = await options.finalize();
      if (!committed) return false;
      lastSaveTimeRef.current = target.lastRead;
    } else if (options?.claimDevice) {
      const committed = await onSaveProgress(target.cfi, safePercent, bookmarks, {
        force: true,
        anchorCfi: target.anchorCfi || target.cfi,
      });
      if (!committed) return false;
      lastSaveTimeRef.current = Date.now();
    } else {
      const adopted = await onAdoptRemoteProgress({
        operation: 'set',
        bookId: target.bookId,
        cfi: target.cfi,
        anchorCfi: target.anchorCfi || target.cfi,
        progressPercent: safePercent,
        lastRead: target.lastRead,
        bookmarks,
        syncRevision: target.syncRevision,
        acceptedEventId: target.acceptedEventId,
      });
      if (!adopted) return false;
      lastSaveTimeRef.current = target.lastRead;
    }

    lastPersistedProgressRef.current = {
      cfi: target.cfi,
      anchorCfi: target.anchorCfi || target.cfi,
      percent: safePercent,
      bookmarksKey,
    };
    lastPersistableLocationRef.current = {
      cfi: target.cfi,
      anchorCfi: target.anchorCfi || target.cfi,
      percent: safePercent,
    };
    clearPendingSave();
    skipNextSaveRef.current = false;
    return true;
  }, [clearPendingSave, onAdoptRemoteProgress, onSaveProgress]);

  const completeRemoteReset = useCallback(async (
    target: Omit<RemoteProgressTarget, 'cfi' | 'anchorCfi' | 'percent'>,
    bookmarks: Bookmark[],
    options?: { finalize?: () => Promise<boolean> },
  ) => {
    const adopted = options?.finalize
      ? await options.finalize()
      : await onAdoptRemoteProgress({
        operation: 'reset',
        bookId: target.bookId,
        cfi: '',
        anchorCfi: '',
        progressPercent: 0,
        lastRead: target.lastRead,
        bookmarks,
        syncRevision: target.syncRevision,
        acceptedEventId: target.acceptedEventId,
      });
    if (!adopted) return false;
    lastSaveTimeRef.current = target.lastRead;
    lastPersistedProgressRef.current = {
      cfi: '',
      anchorCfi: '',
      percent: 0,
      bookmarksKey: getBookmarksKey(bookmarks),
    };
    lastPersistableLocationRef.current = { cfi: '', anchorCfi: '', percent: 0 };
    clearPendingSave();
    skipNextSaveRef.current = false;
    return true;
  }, [clearPendingSave, onAdoptRemoteProgress]);

  return {
    lastSaveTimeRef,
    updateSaveContext,
    markUserProgressChange,
    saveProgressIfChanged,
    handleRelocateForSave,
    saveCurrentProgress,
    flushCurrentProgress,
    prepareRemoteJump,
    prepareRemoteRollback,
    cancelRemoteJump,
    finishRemoteJump,
    isQuietResumeEligible,
    isProgressConflictAutoResolveEligible,
    completeRemoteJump,
    completeRemoteReset,
  };
};
