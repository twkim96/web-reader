'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, UserProgress } from '../../types';

export type SyncConflict = {
  cfi: string;
  percent: number;
  lastRead: number;
};

interface UseRemoteProgressPromptOptions {
  isLoaded: boolean;
  remoteProgress?: UserProgress;
  currentCfi: string;
  totalProgress: number;
  lastSaveTimeRef: MutableRefObject<number>;
  goTo: (cfi: string) => Promise<void>;
  getBookmarks: () => Bookmark[];
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
  totalProgress,
  lastSaveTimeRef,
  goTo,
  getBookmarks,
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
    await goTo(target.cfi);
    completeRemoteJump(target, getBookmarks(), options);
  }, [completeRemoteJump, getBookmarks, goTo, prepareRemoteJump]);

  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;

    const remoteTime = remoteProgress.lastRead;
    const remoteCfi = remoteProgress.cfi;

    if (
      lastProcessedRemote.current &&
      lastProcessedRemote.current.cfi === remoteCfi &&
      lastProcessedRemote.current.lastRead === remoteTime
    ) return;

    lastProcessedRemote.current = { cfi: remoteCfi, lastRead: remoteTime };

    if (isInitialSync.current) {
      isInitialSync.current = false;
      if (remoteCfi && remoteCfi !== currentCfi && remoteTime > lastSaveTimeRef.current) {
        void jumpToRemoteProgress({
          cfi: remoteCfi,
          percent: remoteProgress.progressPercent,
          lastRead: remoteTime,
        });
        return;
      }
    }

    if (lastSaveTimeRef.current && Math.abs(remoteTime - lastSaveTimeRef.current) < 5000) return;
    if (remoteCfi === currentCfi) return;

    if (remoteCfi && remoteTime > lastSaveTimeRef.current) {
      const diff = Math.abs((remoteProgress.progressPercent || 0) - (totalProgress || 0));
      if (diff > 0.03) {
        const nextConflict = {
          cfi: remoteCfi,
          percent: remoteProgress.progressPercent,
          lastRead: remoteTime,
        };
        const timeoutId = window.setTimeout(() => setSyncConflict(nextConflict), 0);
        return () => window.clearTimeout(timeoutId);
      }
    }
  }, [currentCfi, isLoaded, jumpToRemoteProgress, lastSaveTimeRef, remoteProgress, totalProgress]);

  const dismissSyncConflict = useCallback(() => {
    setSyncConflict(null);
  }, []);

  const acceptSyncConflict = useCallback(() => {
    if (!syncConflict) return;
    void jumpToRemoteProgress(syncConflict, { claimDevice: true });
    setSyncConflict(null);
  }, [jumpToRemoteProgress, syncConflict]);

  return {
    syncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  };
};
