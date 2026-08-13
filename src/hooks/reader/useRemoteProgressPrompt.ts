'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, RemoteProgressUpdate } from '../../types';
import { decideRemoteProgressAction } from './remoteProgressPolicy';
import { executeRemoteProgressJump } from './remoteProgressJump';
import type { RemoteProgressJumpCompletion } from './remoteProgressJump';
import type {
  RemoteProgressCommandFinalizeResult,
  ResolvedRemoteProgressCommand,
} from '../useSyncConflictResolution';

export type SyncConflict = {
  operation: 'set' | 'reset';
  bookId: string;
  cfi: string;
  anchorCfi?: string;
  percent: number;
  lastRead: number;
  syncRevision?: number;
  acceptedEventId?: string;
  bookmarks?: Bookmark[];
  resolutionCommandId?: string;
};

interface UseRemoteProgressPromptOptions {
  isLoaded: boolean;
  remoteProgress?: RemoteProgressUpdate;
  resolvedRemoteProgressCommand?: ResolvedRemoteProgressCommand | null;
  onResolvedRemoteProgressConsumed?: (commandId: string) => void;
  onResolvedRemoteProgressFinalize?: (
    commandId: string,
  ) => Promise<RemoteProgressCommandFinalizeResult>;
  onResolvedRemoteProgressCancelled?: (commandId: string) => void;
  outboxConflictRevision?: number;
  ignoredRemoteRevision?: number;
  onIgnoreRemoteProgress?: (revision: number) => Promise<boolean>;
  onPreferLocalProgress?: () => boolean | Promise<boolean>;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  localRevision?: number;
  lastSaveTimeRef: MutableRefObject<number>;
  goTo: (cfi: string) => Promise<boolean>;
  goToFraction: (fraction: number) => Promise<boolean>;
  getBookmarks: () => Bookmark[];
  adoptResolvedBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
  stageAutoBookmark: (prevCfi: string, prevPct: number) => Bookmark[];
  commitBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
  prepareRemoteJump: () => number;
  prepareRemoteRollback: (preparationId: number) => boolean;
  cancelRemoteJump: (preparationId: number) => void;
  finishRemoteJump: (preparationId: number) => void;
  isQuietResumeEligible: () => boolean;
  completeRemoteJump: (
    target: SyncConflict,
    bookmarks: Bookmark[],
    options?: {
      claimDevice?: boolean;
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
    }
  ) => Promise<RemoteProgressJumpCompletion>;
  completeRemoteReset: (
    target: Omit<SyncConflict, 'cfi' | 'anchorCfi' | 'percent' | 'operation'>,
    bookmarks: Bookmark[],
    options?: { finalize?: () => Promise<RemoteProgressCommandFinalizeResult> },
  ) => Promise<RemoteProgressJumpCompletion>;
  hasLocalProgress: boolean;
}

export const useRemoteProgressPrompt = ({
  isLoaded,
  remoteProgress,
  resolvedRemoteProgressCommand,
  onResolvedRemoteProgressConsumed,
  onResolvedRemoteProgressFinalize,
  onResolvedRemoteProgressCancelled,
  outboxConflictRevision,
  ignoredRemoteRevision,
  onIgnoreRemoteProgress,
  onPreferLocalProgress,
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  localRevision,
  lastSaveTimeRef,
  goTo,
  goToFraction,
  getBookmarks,
  adoptResolvedBookmarks,
  stageAutoBookmark,
  commitBookmarks,
  prepareRemoteJump,
  prepareRemoteRollback,
  cancelRemoteJump,
  finishRemoteJump,
  isQuietResumeEligible,
  completeRemoteJump,
  completeRemoteReset,
  hasLocalProgress,
}: UseRemoteProgressPromptOptions) => {
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const [resolvingSyncConflict, setResolvingSyncConflict] = useState(false);
  const lastProcessedRemote = useRef<{
    operation: 'set' | 'reset';
    cfi: string;
    lastRead: number;
  } | null>(null);
  const isInitialSync = useRef(true);
  const jumpGeneration = useRef(0);
  const jumpingRemote = useRef<{
    operation: 'set' | 'reset';
    cfi: string;
    lastRead: number;
  } | null>(null);
  const jumpTail = useRef<Promise<void>>(Promise.resolve());
  const resolvedRemoteProgressCommandRef = useRef(resolvedRemoteProgressCommand);
  useEffect(() => {
    if (
      resolvedRemoteProgressCommandRef.current?.commandId
      !== resolvedRemoteProgressCommand?.commandId
    ) jumpGeneration.current += 1;
    resolvedRemoteProgressCommandRef.current = resolvedRemoteProgressCommand;
  }, [resolvedRemoteProgressCommand]);

  useEffect(() => () => {
    jumpGeneration.current += 1;
  }, []);

  const jumpToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: {
      claimDevice?: boolean;
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
    }
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    try {
      return await executeRemoteProgressJump({
        isCurrent: () => jumpGeneration.current === generation,
        prepare: prepareRemoteJump,
        cancel: cancelRemoteJump,
        finish: finishRemoteJump,
        navigate: async () => {
          const navigation = jumpTail.current
            .catch(() => undefined)
            .then(() => goTo(target.anchorCfi || target.cfi));
          jumpTail.current = navigation.then(() => undefined);
          return navigation;
        },
        rollback: async (preparationId) => {
          const rollbackCfi = currentAnchorCfi || currentCfi;
          if (!rollbackCfi || !prepareRemoteRollback(preparationId)) return;
          await goTo(rollbackCfi);
        },
        complete: () => completeRemoteJump(target, target.bookmarks ?? getBookmarks(), options),
      });
    } catch (error) {
      console.warn('[RemoteProgress] jump failed:', error);
      return false;
    }
  }, [cancelRemoteJump, completeRemoteJump, currentAnchorCfi, currentCfi, finishRemoteJump, getBookmarks, goTo, prepareRemoteJump, prepareRemoteRollback]);

  const resetToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: { finalize?: () => Promise<RemoteProgressCommandFinalizeResult> },
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    try {
      return await executeRemoteProgressJump({
        isCurrent: () => jumpGeneration.current === generation,
        prepare: prepareRemoteJump,
        cancel: cancelRemoteJump,
        finish: finishRemoteJump,
        navigate: () => goToFraction(0),
        rollback: async (preparationId) => {
          const rollbackCfi = currentAnchorCfi || currentCfi;
          if (!rollbackCfi || !prepareRemoteRollback(preparationId)) return;
          await goTo(rollbackCfi);
        },
        complete: () => completeRemoteReset(
          target,
          target.bookmarks ?? getBookmarks(),
          options,
        ),
      });
    } catch (error) {
      console.warn('[RemoteProgress] reset failed:', error);
      return false;
    }
  }, [cancelRemoteJump, completeRemoteReset, currentAnchorCfi, currentCfi, finishRemoteJump, getBookmarks, goTo, goToFraction, prepareRemoteJump, prepareRemoteRollback]);

  const handledResolution = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !resolvedRemoteProgressCommand) return;
    const { commandId, operation, progress } = resolvedRemoteProgressCommand;
    if (handledResolution.current === commandId) return;
    handledResolution.current = commandId;

    if (operation === 'reset') {
      const target: SyncConflict = {
        operation: 'reset',
        bookId: progress.bookId,
        cfi: '',
        anchorCfi: '',
        percent: 0,
        lastRead: progress.lastRead,
        syncRevision: progress.syncRevision,
        acceptedEventId: progress.acceptedEventId,
        bookmarks: progress.bookmarks ?? getBookmarks(),
        resolutionCommandId: commandId,
      };
      let finalizedProgress: ResolvedRemoteProgressCommand['progress'] | null = null;
      void resetToRemoteProgress(target, {
        finalize: async () => {
          const result = await (onResolvedRemoteProgressFinalize?.(commandId)
            ?? Promise.resolve({ status: 'cancelled' as const }));
          if (result.status === 'committed') finalizedProgress = result.progress;
          return result;
        },
      }).then((completed) => {
        if (completed) {
          adoptResolvedBookmarks(finalizedProgress?.bookmarks ?? target.bookmarks ?? []);
          setSyncConflict(null);
          lastProcessedRemote.current = {
            operation: 'reset',
            cfi: '',
            lastRead: progress.lastRead,
          };
          isInitialSync.current = false;
          onResolvedRemoteProgressConsumed?.(commandId);
        } else if (resolvedRemoteProgressCommandRef.current?.commandId === commandId) {
          setSyncConflict(target);
        }
      });
      return;
    }

    const remoteAnchorCfi = progress.anchorCfi || progress.cfi;
    const target: SyncConflict = {
      operation: 'set',
      bookId: progress.bookId,
      cfi: progress.cfi,
      anchorCfi: remoteAnchorCfi,
      percent: progress.progressPercent,
      lastRead: progress.lastRead,
      syncRevision: progress.syncRevision,
      acceptedEventId: progress.acceptedEventId,
      bookmarks: progress.bookmarks ?? getBookmarks(),
      resolutionCommandId: commandId,
    };
    jumpingRemote.current = { operation: 'set', cfi: remoteAnchorCfi, lastRead: target.lastRead };
    let finalizedProgress: ResolvedRemoteProgressCommand['progress'] | null = null;
    void jumpToRemoteProgress(target, {
      finalize: async () => {
        const result = await (onResolvedRemoteProgressFinalize?.(commandId)
          ?? Promise.resolve({ status: 'cancelled' as const }));
        if (result.status === 'committed') finalizedProgress = result.progress;
        return result;
      },
    }).then((completed) => {
      if (
        jumpingRemote.current?.cfi === remoteAnchorCfi
        && jumpingRemote.current.lastRead === target.lastRead
      ) jumpingRemote.current = null;
      if (!completed) {
        if (resolvedRemoteProgressCommandRef.current?.commandId === commandId) {
          setSyncConflict(target);
        }
        return;
      }
      adoptResolvedBookmarks(finalizedProgress?.bookmarks ?? target.bookmarks ?? []);
      setSyncConflict(null);
      lastProcessedRemote.current = { operation: 'set', cfi: remoteAnchorCfi, lastRead: target.lastRead };
      isInitialSync.current = false;
      onResolvedRemoteProgressConsumed?.(commandId);
    });
  }, [
    adoptResolvedBookmarks,
    getBookmarks,
    isLoaded,
    jumpToRemoteProgress,
    onResolvedRemoteProgressConsumed,
    onResolvedRemoteProgressFinalize,
    resetToRemoteProgress,
    resolvedRemoteProgressCommand,
  ]);

  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;

    const remoteTime = remoteProgress.lastRead;
    const remoteOperation = remoteProgress.operation;
    const remoteCfi = remoteProgress.cfi;
    const remoteAnchorCfi = remoteProgress.anchorCfi || remoteCfi;
    const currentAnchor = currentAnchorCfi || currentCfi;

    if (
      ignoredRemoteRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= ignoredRemoteRevision
    ) {
      lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      return;
    }
    if (
      outboxConflictRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= outboxConflictRevision
    ) {
      lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      const timeoutId = window.setTimeout(() => setSyncConflict(null), 0);
      return () => window.clearTimeout(timeoutId);
    }

    if (
      lastProcessedRemote.current &&
      lastProcessedRemote.current.operation === remoteOperation &&
      lastProcessedRemote.current.cfi === remoteAnchorCfi &&
      lastProcessedRemote.current.lastRead === remoteTime
    ) return;
    if (
      jumpingRemote.current
      && jumpingRemote.current.operation === remoteOperation
      && jumpingRemote.current.cfi === remoteAnchorCfi
      && jumpingRemote.current.lastRead === remoteTime
    ) return;

    // A different remote head invalidates any slower jump still in progress.
    jumpGeneration.current += 1;

    const wasInitialSync = isInitialSync.current;
    const action = decideRemoteProgressAction({
      isInitialSync: wasInitialSync,
      operation: remoteOperation,
      hasLocalProgress,
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
    if (action === 'keep-local') {
      lastProcessedRemote.current = {
        operation: remoteOperation,
        cfi: remoteAnchorCfi,
        lastRead: remoteTime,
      };
      isInitialSync.current = false;
      void Promise.resolve(onPreferLocalProgress?.()).catch((error) => {
        console.warn('[RemoteProgress] failed to persist preferred local position:', error);
      });
      return;
    }
    if (action === 'ignore') {
      lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
      isInitialSync.current = false;
      return;
    }

    const target = {
      operation: remoteOperation,
      bookId: remoteProgress.bookId,
      cfi: remoteCfi,
      anchorCfi: remoteAnchorCfi,
      percent: remoteProgress.progressPercent,
      lastRead: remoteTime,
      syncRevision: remoteProgress.syncRevision,
      acceptedEventId: remoteProgress.acceptedEventId,
    };
    if (action === 'jump') {
      jumpingRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
      const jump = remoteOperation === 'reset'
        ? resetToRemoteProgress(target)
        : jumpToRemoteProgress(target);
      void jump.then((completed) => {
        const isSameJump = Boolean(
          jumpingRemote.current?.operation === remoteOperation
          && jumpingRemote.current.cfi === remoteAnchorCfi
          && jumpingRemote.current.lastRead === remoteTime
        );
        if (isSameJump) {
          jumpingRemote.current = null;
        }
        if (!completed) {
          if (!isSameJump) return;
          if (wasInitialSync) return;
          lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
          isInitialSync.current = false;
          setSyncConflict(target);
          return;
        }
        lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
        isInitialSync.current = false;
      });
      return;
    }

    lastProcessedRemote.current = { operation: remoteOperation, cfi: remoteAnchorCfi, lastRead: remoteTime };
    isInitialSync.current = false;
    const timeoutId = window.setTimeout(() => setSyncConflict(target), 0);
    return () => window.clearTimeout(timeoutId);
  }, [currentAnchorCfi, currentCfi, hasLocalProgress, ignoredRemoteRevision, isLoaded, isQuietResumeEligible, jumpToRemoteProgress, lastSaveTimeRef, localRevision, onPreferLocalProgress, outboxConflictRevision, remoteProgress, resetToRemoteProgress, totalProgress]);

  const dismissSyncConflict = useCallback(async () => {
    if (syncConflict?.resolutionCommandId) {
      onResolvedRemoteProgressCancelled?.(syncConflict.resolutionCommandId);
      setSyncConflict(null);
      return;
    }
    if (syncConflict?.syncRevision) {
      const ignored = await onIgnoreRemoteProgress?.(syncConflict.syncRevision);
      if (!ignored) return;
    }
    setSyncConflict(null);
  }, [onIgnoreRemoteProgress, onResolvedRemoteProgressCancelled, syncConflict]);

  const acceptSyncConflict = useCallback(() => {
    if (!syncConflict || resolvingSyncConflict) return;
    setResolvingSyncConflict(true);
    const currentAnchor = currentAnchorCfi || currentCfi;
    const targetAnchor = syncConflict.anchorCfi || syncConflict.cfi;
    const stagedBookmarks = currentCfi
      && targetAnchor !== currentAnchor
      && !syncConflict.resolutionCommandId
      ? stageAutoBookmark(currentAnchor, totalProgress)
      : syncConflict.bookmarks;
    const target = stagedBookmarks
      ? { ...syncConflict, bookmarks: stagedBookmarks }
      : syncConflict;
    let finalizedProgress: ResolvedRemoteProgressCommand['progress'] | null = null;
    const finalize = syncConflict.resolutionCommandId
      ? async () => {
        const result = await (onResolvedRemoteProgressFinalize?.(
          syncConflict.resolutionCommandId!,
        ) ?? Promise.resolve({ status: 'cancelled' as const }));
        if (result.status === 'committed') finalizedProgress = result.progress;
        return result;
      }
      : undefined;
    const jump = target.operation === 'reset'
      ? resetToRemoteProgress(target, { finalize })
      : jumpToRemoteProgress(target, { claimDevice: !finalize, finalize });
    void jump.then((completed) => {
      if (completed) {
        const committedBookmarks = finalizedProgress?.bookmarks
          ?? target.bookmarks
          ?? getBookmarks();
        if (stagedBookmarks) commitBookmarks(committedBookmarks);
        adoptResolvedBookmarks(committedBookmarks);
        if (syncConflict.resolutionCommandId) {
          onResolvedRemoteProgressConsumed?.(syncConflict.resolutionCommandId);
        }
        setSyncConflict(null);
      }
    }).finally(() => setResolvingSyncConflict(false));
  }, [adoptResolvedBookmarks, commitBookmarks, currentAnchorCfi, currentCfi, getBookmarks, jumpToRemoteProgress, onResolvedRemoteProgressConsumed, onResolvedRemoteProgressFinalize, resetToRemoteProgress, resolvingSyncConflict, stageAutoBookmark, syncConflict, totalProgress]);

  return {
    syncConflict,
    resolvingSyncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  };
};
