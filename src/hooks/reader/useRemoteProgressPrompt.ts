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
  isQuietResumeEligible: () => boolean;
  completeRemoteJump: (
    target: SyncConflict,
    bookmarks: Bookmark[],
    options?: { claimDevice?: boolean }
  ) => Promise<boolean>;
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
  isQuietResumeEligible,
  completeRemoteJump,
}: UseRemoteProgressPromptOptions) => {
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const lastProcessedRemote = useRef<{ cfi: string; lastRead: number } | null>(null);
  const isInitialSync = useRef(true);
  const jumpGeneration = useRef(0);
  const jumpingRemote = useRef<{ cfi: string; lastRead: number } | null>(null);
  const jumpTail = useRef<Promise<void>>(Promise.resolve());

  const jumpToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: { claimDevice?: boolean }
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    prepareRemoteJump();
    try {
      const navigation = jumpTail.current
        .catch(() => undefined)
        .then(() => goTo(target.anchorCfi || target.cfi));
      jumpTail.current = navigation;
      await navigation;
      if (jumpGeneration.current !== generation) return false;
      return await completeRemoteJump(target, getBookmarks(), options);
    } catch (error) {
      console.warn('[RemoteProgress] jump failed:', error);
      return false;
    }
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
    if (
      jumpingRemote.current
      && jumpingRemote.current.cfi === remoteAnchorCfi
      && jumpingRemote.current.lastRead === remoteTime
    ) return;

    // A different remote head invalidates any slower jump still in progress.
    jumpGeneration.current += 1;

    const wasInitialSync = isInitialSync.current;
    const action = decideRemoteProgressAction({
      isInitialSync: wasInitialSync,
      remoteAnchorCfi,
      currentAnchorCfi: currentAnchor,
      remoteTime,
      lastSaveTime: lastSaveTimeRef.current,
      remotePercent: remoteProgress.progressPercent,
      currentPercent: totalProgress,
      isQuietResumeEligible: isQuietResumeEligible(),
    });
    if (action === 'ignore') {
      lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      return;
    }

    const target = {
      cfi: remoteCfi,
      anchorCfi: remoteAnchorCfi,
      percent: remoteProgress.progressPercent,
      lastRead: remoteTime,
    };
    if (action === 'jump') {
      jumpingRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      void jumpToRemoteProgress(target).then((completed) => {
        if (
          jumpingRemote.current?.cfi === remoteAnchorCfi
          && jumpingRemote.current.lastRead === remoteTime
        ) {
          jumpingRemote.current = null;
        }
        if (!completed) return;
        lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
        isInitialSync.current = false;
      });
      return;
    }

    lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
    isInitialSync.current = false;
    const timeoutId = window.setTimeout(() => setSyncConflict(target), 0);
    return () => window.clearTimeout(timeoutId);
  }, [currentAnchorCfi, currentCfi, isLoaded, isQuietResumeEligible, jumpToRemoteProgress, lastSaveTimeRef, remoteProgress, totalProgress]);

  const dismissSyncConflict = useCallback(() => {
    setSyncConflict(null);
  }, []);

  const acceptSyncConflict = useCallback(() => {
    if (!syncConflict) return;
    const currentAnchor = currentAnchorCfi || currentCfi;
    const targetAnchor = syncConflict.anchorCfi || syncConflict.cfi;
    if (currentCfi && targetAnchor !== currentAnchor) {
      createAutoBookmark?.(currentAnchor, totalProgress);
    }
    void jumpToRemoteProgress(syncConflict, { claimDevice: true }).then((completed) => {
      if (completed) setSyncConflict(null);
    });
  }, [createAutoBookmark, currentAnchorCfi, currentCfi, jumpToRemoteProgress, syncConflict, totalProgress]);

  return {
    syncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  };
};
