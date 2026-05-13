'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Bookmark, SaveProgressOptions } from '../../types';
import { getBookmarksKey, getRelocatePercent, ReaderRelocateDetail, toClampedPercent } from './progress';

type SaveContext = {
  currentCfi: string;
  totalProgress: number;
  bookmarks: Bookmark[];
  hasSyncConflict: boolean;
};

type RemoteProgressTarget = {
  cfi: string;
  percent: number;
  lastRead: number;
};

type PendingRelocateSave = {
  cfi: string;
  percent: number;
  bookmarks: Bookmark[];
};

interface UseReaderProgressSaveOptions {
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => void;
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
}: UseReaderProgressSaveOptions) => {
  const lastSaveTimeRef = useRef(initialTime || 0);
  const skipNextSaveRef = useRef(true);
  const hasUnsavedUserChangeRef = useRef(false);
  const forceNextRelocateSaveRef = useRef(false);
  const pendingExpectedPercentRef = useRef<number | null>(null);
  const pendingBookmarksRef = useRef<Bookmark[] | null>(null);
  const pendingRelocateSaveRef = useRef<PendingRelocateSave | null>(null);
  const relocateSaveTimerRef = useRef<number | null>(null);
  const unsavedSinceRef = useRef<number | null>(null);
  const saveContextRef = useRef<SaveContext>({
    currentCfi: '',
    totalProgress: 0,
    bookmarks: initialBookmarks || [],
    hasSyncConflict: false,
  });
  const lastPersistedProgressRef = useRef({
    cfi: initialCfi || '',
    percent: toClampedPercent(initialPercent) ?? 0,
    bookmarksKey: getBookmarksKey(initialBookmarks),
  });

  const updateSaveContext = useCallback((context: SaveContext) => {
    saveContextRef.current = context;
  }, []);

  const markUserProgressChange = useCallback((options?: {
    forceNextRelocateSave?: boolean;
    expectedPercent?: number;
    bookmarks?: Bookmark[];
  }) => {
    hasUnsavedUserChangeRef.current = true;
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

  const saveProgressIfChanged = useCallback((
    cfi: string,
    pct: number,
    nextBookmarks: Bookmark[],
    options?: { force?: boolean }
  ) => {
    if (!options?.force && !hasUnsavedUserChangeRef.current) return false;

    const safePercent = toClampedPercent(pct);
    if (!cfi || safePercent === null) return false;

    const nextBookmarksKey = getBookmarksKey(nextBookmarks);
    const previous = lastPersistedProgressRef.current;
    const hasChanged = previous.cfi !== cfi ||
      Math.abs(previous.percent - safePercent) >= 0.05 ||
      previous.bookmarksKey !== nextBookmarksKey;

    if (!options?.force && !hasChanged) {
      clearPendingSave();
      return false;
    }

    onSaveProgress(cfi, safePercent, nextBookmarks, options?.force ? { force: true } : undefined);
    lastPersistedProgressRef.current = {
      cfi,
      percent: safePercent,
      bookmarksKey: nextBookmarksKey,
    };
    lastSaveTimeRef.current = Date.now();
    clearPendingSave();
    return true;
  }, [clearPendingSave, onSaveProgress]);

  const savePendingRelocate = useCallback(() => {
    const pending = pendingRelocateSaveRef.current;
    if (!pending) return false;

    return saveProgressIfChanged(
      pending.cfi,
      pending.percent,
      pending.bookmarks
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
      saveProgressIfChanged(pending.cfi, pending.percent, pending.bookmarks);
      return;
    }

    clearRelocateSaveTimer();
    relocateSaveTimerRef.current = window.setTimeout(() => {
      relocateSaveTimerRef.current = null;
      savePendingRelocate();
    }, options?.delayMs ?? RELOCATE_SAVE_IDLE_MS);
  }, [clearRelocateSaveTimer, savePendingRelocate, saveProgressIfChanged]);

  const handleRelocateForSave = useCallback((detail: ReaderRelocateDetail) => {
    if (!detail.cfi) return;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    if (!hasUnsavedUserChangeRef.current) return;

    const { totalProgress, bookmarks, hasSyncConflict } = saveContextRef.current;
    if (hasSyncConflict) return;

    const fallbackPercent = pendingExpectedPercentRef.current ?? totalProgress;
    const pct = getRelocatePercent(detail, fallbackPercent);
    if (pct === null) return;

    const pending = {
      cfi: detail.cfi,
      percent: pct,
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

  const saveCurrentProgress = useCallback(() => {
    const { currentCfi, totalProgress, bookmarks } = saveContextRef.current;
    if (!currentCfi) return false;
    clearRelocateSaveTimer();
    if (pendingRelocateSaveRef.current) {
      return savePendingRelocate();
    }
    return saveProgressIfChanged(
      currentCfi,
      totalProgress,
      pendingBookmarksRef.current || bookmarks
    );
  }, [clearRelocateSaveTimer, savePendingRelocate, saveProgressIfChanged]);

  const prepareRemoteJump = useCallback(() => {
    skipNextSaveRef.current = true;
    clearPendingSave();
  }, [clearPendingSave]);

  useEffect(() => () => {
    clearRelocateSaveTimer();
  }, [clearRelocateSaveTimer]);

  const completeRemoteJump = useCallback((
    target: RemoteProgressTarget,
    bookmarks: Bookmark[],
    options?: { claimDevice?: boolean }
  ) => {
    const safePercent = toClampedPercent(target.percent) ?? 0;
    const bookmarksKey = getBookmarksKey(bookmarks);

    if (options?.claimDevice) {
      onSaveProgress(target.cfi, safePercent, bookmarks, { force: true });
      lastSaveTimeRef.current = Date.now();
    } else {
      lastSaveTimeRef.current = target.lastRead;
    }

    lastPersistedProgressRef.current = {
      cfi: target.cfi,
      percent: safePercent,
      bookmarksKey,
    };
    clearPendingSave();
  }, [clearPendingSave, onSaveProgress]);

  return {
    lastSaveTimeRef,
    updateSaveContext,
    markUserProgressChange,
    saveProgressIfChanged,
    handleRelocateForSave,
    saveCurrentProgress,
    prepareRemoteJump,
    completeRemoteJump,
  };
};
