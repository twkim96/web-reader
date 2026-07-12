'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, UserProgress } from '../../types';

export type SyncConflict = {
  cfi: string;
  anchorCfi?: string;
  percent: number;
  lastRead: number;
};

interface UseRemoteProgressPromptOptions {
  isLoaded: boolean;
  remoteProgress?: UserProgress;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  lastSaveTimeRef: MutableRefObject<number>;
  goTo: (cfi: string) => Promise<void>;
  getBookmarks: () => Bookmark[];
  createAutoBookmark?: (prevCfi: string, prevPct: number) => Bookmark[];
  prepareRemoteJump: () => void;
  completeRemoteJump: (
    target: SyncConflict,
    bookmarks: Bookmark[],
    options?: { claimDevice?: boolean }
  ) => void;
}

export const useRemoteProgressPrompt = ({
  isLoaded,
  remoteProgress,
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  lastSaveTimeRef,
  goTo,
  getBookmarks,
  createAutoBookmark,
  prepareRemoteJump,
  completeRemoteJump,
}: UseRemoteProgressPromptOptions) => {
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const lastProcessedRemote = useRef<{ cfi: string; lastRead: number } | null>(null);
  const isInitialSync = useRef(true);

  const jumpToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: { claimDevice?: boolean }
  ) => {
    prepareRemoteJump();
    await goTo(target.anchorCfi || target.cfi);
    completeRemoteJump(target, getBookmarks(), options);
  }, [completeRemoteJump, getBookmarks, goTo, prepareRemoteJump]);

  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;

    const remoteTime = remoteProgress.lastRead;
    const remoteCfi = remoteProgress.cfi;
    const remoteAnchorCfi = remoteProgress.anchorCfi || remoteCfi;
    const currentAnchor = currentAnchorCfi || currentCfi;

    if (
      lastProcessedRemote.current &&
      lastProcessedRemote.current.cfi === remoteAnchorCfi &&
      lastProcessedRemote.current.lastRead === remoteTime
    ) return;

    lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };

    if (isInitialSync.current) {
      isInitialSync.current = false;
      if (remoteAnchorCfi && remoteAnchorCfi !== currentAnchor && remoteTime > lastSaveTimeRef.current) {
        const initialConflict = {
          cfi: remoteCfi,
          anchorCfi: remoteAnchorCfi,
          percent: remoteProgress.progressPercent,
          lastRead: remoteTime,
        };
        const timeoutId = window.setTimeout(() => setSyncConflict(initialConflict), 0);
        return () => window.clearTimeout(timeoutId);
      }
    }

    if (remoteAnchorCfi === currentAnchor) return;

    if (remoteAnchorCfi && remoteTime > lastSaveTimeRef.current) {
      const diff = Math.abs((remoteProgress.progressPercent || 0) - (totalProgress || 0));
      if (diff > 0.03) {
        const nextConflict = {
          cfi: remoteCfi,
          anchorCfi: remoteAnchorCfi,
          percent: remoteProgress.progressPercent,
          lastRead: remoteTime,
        };
        const timeoutId = window.setTimeout(() => setSyncConflict(nextConflict), 0);
        return () => window.clearTimeout(timeoutId);
      }
    }
  }, [currentAnchorCfi, currentCfi, isLoaded, jumpToRemoteProgress, lastSaveTimeRef, remoteProgress, totalProgress]);

  const dismissSyncConflict = useCallback(() => {
    setSyncConflict(null);
  }, []);

  const acceptSyncConflict = useCallback(() => {
    if (!syncConflict) return;
    const currentAnchor = currentAnchorCfi || currentCfi;
    const targetAnchor = syncConflict.anchorCfi || syncConflict.cfi;
    if (currentCfi && targetAnchor !== currentAnchor) {
      createAutoBookmark?.(currentCfi, totalProgress);
    }
    void jumpToRemoteProgress(syncConflict, { claimDevice: true });
    setSyncConflict(null);
  }, [createAutoBookmark, currentAnchorCfi, currentCfi, jumpToRemoteProgress, syncConflict, totalProgress]);

  return {
    syncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  };
};
