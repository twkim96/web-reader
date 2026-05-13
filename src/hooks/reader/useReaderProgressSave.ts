'use client';

import { useCallback, useRef } from 'react';
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

interface UseReaderProgressSaveOptions {
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => void;
}

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
  const pendingBookmarksRef = useRef<Bookmark[] | null>(null);
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
    bookmarks?: Bookmark[];
  }) => {
    hasUnsavedUserChangeRef.current = true;
    if (options?.forceNextRelocateSave) {
      forceNextRelocateSaveRef.current = true;
    }
    if (options?.bookmarks) {
      pendingBookmarksRef.current = options.bookmarks;
    }
  }, []);

  const clearPendingSave = useCallback(() => {
    hasUnsavedUserChangeRef.current = false;
    forceNextRelocateSaveRef.current = false;
    pendingBookmarksRef.current = null;
  }, []);

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

  const handleRelocateForSave = useCallback((detail: ReaderRelocateDetail) => {
    if (!detail.cfi) return;

    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }

    if (!hasUnsavedUserChangeRef.current) return;

    const { totalProgress, bookmarks, hasSyncConflict } = saveContextRef.current;
    if (hasSyncConflict) return;

    const pct = getRelocatePercent(detail, totalProgress);
    if (pct === null) return;

    const now = Date.now();
    const shouldSaveNow = forceNextRelocateSaveRef.current || now - lastSaveTimeRef.current > 5000;
    if (!shouldSaveNow) return;

    saveProgressIfChanged(
      detail.cfi,
      pct,
      pendingBookmarksRef.current || bookmarks
    );
  }, [saveProgressIfChanged]);

  const saveCurrentProgress = useCallback(() => {
    const { currentCfi, totalProgress, bookmarks } = saveContextRef.current;
    if (!currentCfi) return false;
    return saveProgressIfChanged(
      currentCfi,
      totalProgress,
      pendingBookmarksRef.current || bookmarks
    );
  }, [saveProgressIfChanged]);

  const prepareRemoteJump = useCallback(() => {
    skipNextSaveRef.current = true;
    clearPendingSave();
  }, [clearPendingSave]);

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
