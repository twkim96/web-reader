'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, UserProgress } from '../../types';
import { decideRemoteProgressAction } from './remoteProgressPolicy';
import { executeRemoteProgressJump } from './remoteProgressJump';
import type { ResolvedRemoteProgressCommand } from '../useSyncConflictResolution';

export type SyncConflict = {
  bookId: string;
  cfi: string;
  anchorCfi?: string;
  percent: number;
  lastRead: number;
  syncRevision?: number;
  acceptedEventId?: string;
  bookmarks?: Bookmark[];
};

interface UseRemoteProgressPromptOptions {
  isLoaded: boolean;
  remoteProgress?: UserProgress;
  resolvedRemoteProgressCommand?: ResolvedRemoteProgressCommand | null;
  onResolvedRemoteProgressConsumed?: (commandId: string) => void;
  outboxConflictRevision?: number;
  ignoredRemoteRevision?: number;
  onIgnoreRemoteProgress?: (revision: number) => Promise<boolean>;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  localRevision?: number;
  lastSaveTimeRef: MutableRefObject<number>;
  goTo: (cfi: string) => Promise<void>;
  goToFraction: (fraction: number) => Promise<void>;
  getBookmarks: () => Bookmark[];
  adoptResolvedBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
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
  resolvedRemoteProgressCommand,
  onResolvedRemoteProgressConsumed,
  outboxConflictRevision,
  ignoredRemoteRevision,
  onIgnoreRemoteProgress,
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  localRevision,
  lastSaveTimeRef,
  goTo,
  goToFraction,
  getBookmarks,
  adoptResolvedBookmarks,
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
    try {
      return await executeRemoteProgressJump({
        claimDevice: Boolean(options?.claimDevice),
        isCurrent: () => jumpGeneration.current === generation,
        prepare: prepareRemoteJump,
        navigate: async () => {
          const navigation = jumpTail.current
            .catch(() => undefined)
            .then(() => goTo(target.anchorCfi || target.cfi));
          jumpTail.current = navigation;
          await navigation;
        },
        complete: () => completeRemoteJump(target, target.bookmarks ?? getBookmarks(), options),
      });
    } catch (error) {
      console.warn('[RemoteProgress] jump failed:', error);
      return false;
    }
  }, [completeRemoteJump, getBookmarks, goTo, prepareRemoteJump]);

  const handledResolution = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !resolvedRemoteProgressCommand) return;
    const { commandId, operation, progress } = resolvedRemoteProgressCommand;
    if (handledResolution.current === commandId) return;
    handledResolution.current = commandId;

    if (operation === 'reset') {
      prepareRemoteJump();
      adoptResolvedBookmarks(progress.bookmarks ?? getBookmarks());
      void goToFraction(0)
        .catch((error) => console.warn('[RemoteProgress] reset failed:', error))
        .finally(() => {
          setSyncConflict(null);
          lastProcessedRemote.current = { cfi: '', lastRead: progress.lastRead };
          isInitialSync.current = false;
          onResolvedRemoteProgressConsumed?.(commandId);
        });
      return;
    }

    const remoteAnchorCfi = progress.anchorCfi || progress.cfi;
    const target: SyncConflict = {
      bookId: progress.bookId,
      cfi: progress.cfi,
      anchorCfi: remoteAnchorCfi,
      percent: progress.progressPercent,
      lastRead: progress.lastRead,
      syncRevision: progress.syncRevision,
      acceptedEventId: progress.acceptedEventId,
      bookmarks: adoptResolvedBookmarks(progress.bookmarks ?? getBookmarks()),
    };
    jumpingRemote.current = { cfi: remoteAnchorCfi, lastRead: target.lastRead };
    void jumpToRemoteProgress(target).then((completed) => {
      if (
        jumpingRemote.current?.cfi === remoteAnchorCfi
        && jumpingRemote.current.lastRead === target.lastRead
      ) jumpingRemote.current = null;
      if (!completed) {
        setSyncConflict(target);
        return;
      }
      setSyncConflict(null);
      lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: target.lastRead };
      isInitialSync.current = false;
    }).finally(() => onResolvedRemoteProgressConsumed?.(commandId));
  }, [
    adoptResolvedBookmarks,
    getBookmarks,
    goToFraction,
    isLoaded,
    jumpToRemoteProgress,
    onResolvedRemoteProgressConsumed,
    prepareRemoteJump,
    resolvedRemoteProgressCommand,
  ]);

  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;

    const remoteTime = remoteProgress.lastRead;
    const remoteCfi = remoteProgress.cfi;
    const remoteAnchorCfi = remoteProgress.anchorCfi || remoteCfi;
    const currentAnchor = currentAnchorCfi || currentCfi;

    if (
      ignoredRemoteRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= ignoredRemoteRevision
    ) {
      lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      return;
    }
    if (
      outboxConflictRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= outboxConflictRevision
    ) {
      lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      const timeoutId = window.setTimeout(() => setSyncConflict(null), 0);
      return () => window.clearTimeout(timeoutId);
    }

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
      remoteRevision: remoteProgress.syncRevision,
      localRevision,
    });
    if (action === 'ignore') {
      lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      return;
    }

    const target = {
      bookId: remoteProgress.bookId,
      cfi: remoteCfi,
      anchorCfi: remoteAnchorCfi,
      percent: remoteProgress.progressPercent,
      lastRead: remoteTime,
      syncRevision: remoteProgress.syncRevision,
      acceptedEventId: remoteProgress.acceptedEventId,
    };
    if (action === 'jump') {
      jumpingRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
      void jumpToRemoteProgress(target).then((completed) => {
        const isSameJump = Boolean(
          jumpingRemote.current?.cfi === remoteAnchorCfi
          && jumpingRemote.current.lastRead === remoteTime
        );
        if (isSameJump) {
          jumpingRemote.current = null;
        }
        if (!completed) {
          if (!isSameJump) return;
          if (wasInitialSync) return;
          lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
          isInitialSync.current = false;
          setSyncConflict(target);
          return;
        }
        lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
        isInitialSync.current = false;
      });
      return;
    }

    lastProcessedRemote.current = { cfi: remoteAnchorCfi, lastRead: remoteTime };
    isInitialSync.current = false;
    const timeoutId = window.setTimeout(() => setSyncConflict(target), 0);
    return () => window.clearTimeout(timeoutId);
  }, [currentAnchorCfi, currentCfi, ignoredRemoteRevision, isLoaded, isQuietResumeEligible, jumpToRemoteProgress, lastSaveTimeRef, localRevision, outboxConflictRevision, remoteProgress, totalProgress]);

  const dismissSyncConflict = useCallback(() => {
    if (syncConflict?.syncRevision) {
      void onIgnoreRemoteProgress?.(syncConflict.syncRevision);
    }
    setSyncConflict(null);
  }, [onIgnoreRemoteProgress, syncConflict]);

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
