'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, UserProgress } from '../../types';
import { decideRemoteProgressAction } from './remoteProgressPolicy';

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

    const wasInitialSync = isInitialSync.current;
    isInitialSync.current = false;
    const action = decideRemoteProgressAction({
      isInitialSync: wasInitialSync,
      remoteAnchorCfi,
      currentAnchorCfi: currentAnchor,
      remoteTime,
      lastSaveTime: lastSaveTimeRef.current,
      remotePercent: remoteProgress.progressPercent,
      currentPercent: totalProgress,
    });
    if (action === 'ignore') return;

    const target = {
      cfi: remoteCfi,
      anchorCfi: remoteAnchorCfi,
      percent: remoteProgress.progressPercent,
      lastRead: remoteTime,
    };
    if (action === 'jump') {
      void jumpToRemoteProgress(target);
      return;
    }

    const timeoutId = window.setTimeout(() => setSyncConflict(target), 0);
    return () => window.clearTimeout(timeoutId);
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
