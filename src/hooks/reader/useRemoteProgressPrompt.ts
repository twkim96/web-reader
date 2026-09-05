'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  RemoteProgressAdoptionResult,
  RemoteProgressUpdate,
} from '../../types';
import { decideRemoteProgressAction } from './remoteProgressPolicy';
import { executeRemoteProgressJump } from './remoteProgressJump';
import type { RemoteProgressJumpCompletion } from './remoteProgressJump';
import type {
  RemoteProgressCommandFinalizeResult,
  ResolvedRemoteProgressCommand,
} from '../useSyncConflictResolution';
import { finalizeRemoteProgressCommand } from './remoteProgressCommand';
import {
  executeCanonicalRemoteProgressNavigation,
  getRemoteProgressIdentity,
} from './remoteProgressAdoption';
import { hashReaderTraceValue, traceReaderBootstrap } from '../../lib/readerBootstrapTrace';
import type { ReaderRemoteNavigationAttempt } from './useReaderProgressSave';

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
    signal?: AbortSignal,
  ) => Promise<RemoteProgressCommandFinalizeResult>;
  onResolvedRemoteProgressCancelled?: (commandId: string) => void;
  outboxConflictRevision?: number;
  ignoredRemoteRevision?: number;
  onIgnoreRemoteProgress?: (revision: number) => Promise<boolean>;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  localRevision?: number;
  lastSaveTimeRef: MutableRefObject<number>;
  waitForNavigationReady: () => Promise<boolean>;
  goToStable: (cfi: string) => Promise<boolean>;
  goToFractionStable: (fraction: number) => Promise<boolean>;
  getBookmarks: () => Bookmark[];
  adoptResolvedBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
  stageAutoBookmark: (prevCfi: string, prevPct: number) => Bookmark[];
  commitBookmarks: (bookmarks: Bookmark[]) => Bookmark[];
  prepareRemoteJump: () => number;
  prepareRemoteRollback: (preparationId: number) => boolean;
  cancelRemoteJump: (preparationId: number) => void;
  finishRemoteJump: (preparationId: number) => void;
  beginRemoteNavigationAttempt: () => ReaderRemoteNavigationAttempt;
  isRemoteNavigationAttemptCurrent: (attempt: ReaderRemoteNavigationAttempt) => boolean;
  finishRemoteNavigationAttempt: (attempt: ReaderRemoteNavigationAttempt) => void;
  isQuietResumeEligible: () => boolean;
  isProgressConflictAutoResolveEligible: () => boolean;
  adoptRemoteProgressBeforeNavigation: (
    progress: RemoteProgressUpdate,
    signal?: AbortSignal,
  ) => Promise<RemoteProgressAdoptionResult>;
  completeRemoteJump: (
    target: SyncConflict,
    bookmarks: Bookmark[],
    options?: {
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
      signal?: AbortSignal;
    }
  ) => Promise<RemoteProgressJumpCompletion>;
  completeRemoteReset: (
    target: Omit<SyncConflict, 'cfi' | 'anchorCfi' | 'percent' | 'operation'>,
    bookmarks: Bookmark[],
    options?: {
      finalize?: () => Promise<RemoteProgressCommandFinalizeResult>;
      signal?: AbortSignal;
    },
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
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  localRevision,
  lastSaveTimeRef,
  waitForNavigationReady,
  goToStable,
  goToFractionStable,
  getBookmarks,
  adoptResolvedBookmarks,
  stageAutoBookmark,
  commitBookmarks,
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
  hasLocalProgress,
}: UseRemoteProgressPromptOptions) => {
  const [syncConflict, setSyncConflict] = useState<SyncConflict | null>(null);
  const [syncConflictFeedback, setSyncConflictFeedback] = useState<string | null>(null);
  const [resolvingSyncConflict, setResolvingSyncConflict] = useState(false);
  const [remoteRetryNonce, setRemoteRetryNonce] = useState(0);
  const lastProcessedRemoteIdentity = useRef<string | null>(null);
  const isInitialSync = useRef(true);
  const jumpGeneration = useRef(0);
  const jumpingRemoteIdentity = useRef<string | null>(null);
  const jumpTail = useRef<Promise<void>>(Promise.resolve());
  const automaticRetryRef = useRef<{ identity: string | null; attempts: number; timer: number | null }>({
    identity: null,
    attempts: 0,
    timer: null,
  });
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
    if (automaticRetryRef.current.timer !== null) {
      window.clearTimeout(automaticRetryRef.current.timer);
    }
  }, []);

  const navigateToRemoteSet = useCallback((target: SyncConflict) => {
    const navigation = jumpTail.current
      .catch(() => undefined)
      .then(async () => {
        const primary = target.cfi || target.anchorCfi || '';
        if (primary && await goToStable(primary)) return true;
        const fallback = target.anchorCfi || '';
        if (fallback && fallback !== primary) return goToStable(fallback);
        return false;
      });
    jumpTail.current = navigation.then(() => undefined);
    return navigation;
  }, [goToStable]);

  const isRuntimeModeEligible = useCallback((
    runtimeMode: ResolvedRemoteProgressCommand['runtimeMode'],
  ) => {
    if (runtimeMode === 'quiet') return isQuietResumeEligible();
    if (runtimeMode === 'settled') return isProgressConflictAutoResolveEligible();
    return true;
  }, [isProgressConflictAutoResolveEligible, isQuietResumeEligible]);

  const rollbackToLocalPosition = useCallback(async (preparationId: number) => {
    if (!prepareRemoteRollback(preparationId)) return false;
    const candidates = [currentCfi, currentAnchorCfi]
      .filter((candidate, index, all): candidate is string => (
        Boolean(candidate) && all.indexOf(candidate) === index
      ));
    for (const candidate of candidates) {
      if (await goToStable(candidate)) return true;
    }
    const fraction = Math.min(1, Math.max(0, totalProgress / 100));
    return goToFractionStable(fraction);
  }, [
    currentAnchorCfi,
    currentCfi,
    goToFractionStable,
    goToStable,
    prepareRemoteRollback,
    totalProgress,
  ]);

  const jumpToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: { finalize?: (signal?: AbortSignal) => Promise<RemoteProgressCommandFinalizeResult> },
    runtimeMode: ResolvedRemoteProgressCommand['runtimeMode'] = 'explicit',
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    const attempt = beginRemoteNavigationAttempt();
    const isCurrent = () => (
      jumpGeneration.current === generation
      && isRemoteNavigationAttemptCurrent(attempt)
      && isRuntimeModeEligible(runtimeMode)
    );
    let rollbackRestored: boolean | null = null;
    try {
      const completed = await executeRemoteProgressJump({
        isCurrent,
        ready: waitForNavigationReady,
        prepare: prepareRemoteJump,
        cancel: cancelRemoteJump,
        finish: finishRemoteJump,
        navigate: async () => {
          const navigation = jumpTail.current
            .catch(() => undefined)
            .then(() => goToStable(target.cfi || target.anchorCfi || ''));
          jumpTail.current = navigation.then(() => undefined);
          return navigation;
        },
        rollback: async (preparationId) => {
          rollbackRestored = await rollbackToLocalPosition(preparationId);
          return rollbackRestored;
        },
        complete: () => completeRemoteJump(
          target,
          target.bookmarks ?? getBookmarks(),
          {
            ...(options?.finalize
              ? { finalize: () => options.finalize!(attempt.signal) }
              : {}),
            signal: attempt.signal,
          },
        ),
      });
      if (!completed && rollbackRestored === false) {
        setSyncConflictFeedback('현재 위치 복원에 실패했습니다. 충돌 창을 닫지 말고 다시 이동을 시도해 주세요.');
      }
      return completed;
    } catch (error) {
      console.warn('[RemoteProgress] jump failed:', error);
      if (rollbackRestored === false) {
        setSyncConflictFeedback('현재 위치 복원에 실패했습니다. 충돌 창을 닫지 말고 다시 이동을 시도해 주세요.');
      }
      return false;
    } finally {
      finishRemoteNavigationAttempt(attempt);
    }
  }, [beginRemoteNavigationAttempt, cancelRemoteJump, completeRemoteJump, finishRemoteJump, finishRemoteNavigationAttempt, getBookmarks, goToStable, isRemoteNavigationAttemptCurrent, isRuntimeModeEligible, prepareRemoteJump, rollbackToLocalPosition, waitForNavigationReady]);

  const resetToRemoteProgress = useCallback(async (
    target: SyncConflict,
    options?: { finalize?: (signal?: AbortSignal) => Promise<RemoteProgressCommandFinalizeResult> },
    runtimeMode: ResolvedRemoteProgressCommand['runtimeMode'] = 'explicit',
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    const attempt = beginRemoteNavigationAttempt();
    const isCurrent = () => (
      jumpGeneration.current === generation
      && isRemoteNavigationAttemptCurrent(attempt)
      && isRuntimeModeEligible(runtimeMode)
    );
    let rollbackRestored: boolean | null = null;
    try {
      const completed = await executeRemoteProgressJump({
        isCurrent,
        ready: waitForNavigationReady,
        prepare: prepareRemoteJump,
        cancel: cancelRemoteJump,
        finish: finishRemoteJump,
        navigate: () => goToFractionStable(0),
        rollback: async (preparationId) => {
          rollbackRestored = await rollbackToLocalPosition(preparationId);
          return rollbackRestored;
        },
        complete: () => completeRemoteReset(
          target,
          target.bookmarks ?? getBookmarks(),
          {
            ...(options?.finalize
              ? { finalize: () => options.finalize!(attempt.signal) }
              : {}),
            signal: attempt.signal,
          },
        ),
      });
      if (!completed && rollbackRestored === false) {
        setSyncConflictFeedback('현재 위치 복원에 실패했습니다. 충돌 창을 닫지 말고 다시 이동을 시도해 주세요.');
      }
      return completed;
    } catch (error) {
      console.warn('[RemoteProgress] reset failed:', error);
      if (rollbackRestored === false) {
        setSyncConflictFeedback('현재 위치 복원에 실패했습니다. 충돌 창을 닫지 말고 다시 이동을 시도해 주세요.');
      }
      return false;
    } finally {
      finishRemoteNavigationAttempt(attempt);
    }
  }, [beginRemoteNavigationAttempt, cancelRemoteJump, completeRemoteReset, finishRemoteJump, finishRemoteNavigationAttempt, getBookmarks, goToFractionStable, isRemoteNavigationAttemptCurrent, isRuntimeModeEligible, prepareRemoteJump, rollbackToLocalPosition, waitForNavigationReady]);

  const adoptAndNavigateRemoteProgress = useCallback(async (
    target: SyncConflict,
    runtimeMode: ResolvedRemoteProgressCommand['runtimeMode'] = 'explicit',
  ) => {
    const generation = jumpGeneration.current + 1;
    jumpGeneration.current = generation;
    const attempt = beginRemoteNavigationAttempt();
    const isCurrent = () => (
      jumpGeneration.current === generation
      && isRemoteNavigationAttemptCurrent(attempt)
      && isRuntimeModeEligible(runtimeMode)
    );
    try {
      return await executeCanonicalRemoteProgressNavigation({
        isCurrent,
        // Once canonical adoption commits, finish the viewport move even if a
        // user input lands in the tiny post-commit window. Before commit the
        // attempt signal aborts the IndexedDB transaction instead.
        isCurrentAfterCommit: () => jumpGeneration.current === generation,
        ready: waitForNavigationReady,
        adopt: () => adoptRemoteProgressBeforeNavigation({
          operation: target.operation,
          bookId: target.bookId,
          cfi: target.operation === 'reset' ? '' : target.cfi,
          anchorCfi: target.operation === 'reset'
            ? ''
            : target.anchorCfi || target.cfi,
          progressPercent: target.operation === 'reset' ? 0 : target.percent,
          lastRead: target.lastRead,
          bookmarks: target.bookmarks ?? getBookmarks(),
          syncRevision: target.syncRevision,
          acceptedEventId: target.acceptedEventId,
        }, attempt.signal),
        prepare: prepareRemoteJump,
        cancel: cancelRemoteJump,
        finish: finishRemoteJump,
        navigate: target.operation === 'reset'
          ? () => goToFractionStable(0)
          : () => navigateToRemoteSet(target),
      });
    } catch (error) {
      console.warn('[RemoteProgress] canonical navigation failed:', error);
      return { status: 'cancelled' as const, retryable: true };
    } finally {
      finishRemoteNavigationAttempt(attempt);
    }
  }, [
    adoptRemoteProgressBeforeNavigation,
    beginRemoteNavigationAttempt,
    cancelRemoteJump,
    finishRemoteJump,
    finishRemoteNavigationAttempt,
    getBookmarks,
    goToFractionStable,
    isRemoteNavigationAttemptCurrent,
    isRuntimeModeEligible,
    navigateToRemoteSet,
    prepareRemoteJump,
    waitForNavigationReady,
  ]);

  const handledResolution = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !resolvedRemoteProgressCommand) return;
    const { commandId, operation, progress } = resolvedRemoteProgressCommand;
    if (handledResolution.current === commandId) return;
    handledResolution.current = commandId;
    const commandIdentity = getRemoteProgressIdentity({
      operation: operation === 'reset' ? 'reset' : 'set',
      cfi: progress.cfi,
      anchorCfi: progress.anchorCfi,
      lastRead: progress.lastRead,
      syncRevision: progress.syncRevision,
      acceptedEventId: progress.acceptedEventId,
    });
    jumpingRemoteIdentity.current = commandIdentity;

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
        finalize: async (signal) => {
          const result = await finalizeRemoteProgressCommand(
            resolvedRemoteProgressCommand,
            onResolvedRemoteProgressFinalize
              ? () => onResolvedRemoteProgressFinalize(commandId, signal)
              : undefined,
          );
          if (result.status === 'committed') finalizedProgress = result.progress;
          return result;
        },
      }, resolvedRemoteProgressCommand.runtimeMode).then((completed) => {
        if (jumpingRemoteIdentity.current === commandIdentity) {
          jumpingRemoteIdentity.current = null;
        }
        if (completed) {
          adoptResolvedBookmarks(finalizedProgress?.bookmarks ?? target.bookmarks ?? []);
          setSyncConflictFeedback(null);
          setSyncConflict(null);
          lastProcessedRemoteIdentity.current = commandIdentity;
          isInitialSync.current = false;
          onResolvedRemoteProgressConsumed?.(commandId);
        } else if (resolvedRemoteProgressCommandRef.current?.commandId === commandId) {
          setSyncConflictFeedback(null);
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
    let finalizedProgress: ResolvedRemoteProgressCommand['progress'] | null = null;
    void jumpToRemoteProgress(target, {
      finalize: async (signal) => {
        const result = await finalizeRemoteProgressCommand(
          resolvedRemoteProgressCommand,
          onResolvedRemoteProgressFinalize
            ? () => onResolvedRemoteProgressFinalize(commandId, signal)
            : undefined,
        );
        if (result.status === 'committed') finalizedProgress = result.progress;
        return result;
      },
    }, resolvedRemoteProgressCommand.runtimeMode).then((completed) => {
      if (jumpingRemoteIdentity.current === commandIdentity) {
        jumpingRemoteIdentity.current = null;
      }
      if (!completed) {
        if (resolvedRemoteProgressCommandRef.current?.commandId === commandId) {
          setSyncConflictFeedback(null);
          setSyncConflict(target);
        }
        return;
      }
      adoptResolvedBookmarks(finalizedProgress?.bookmarks ?? target.bookmarks ?? []);
      setSyncConflictFeedback(null);
      setSyncConflict(null);
      lastProcessedRemoteIdentity.current = commandIdentity;
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
    const remoteIdentity = getRemoteProgressIdentity(remoteProgress);
    if (automaticRetryRef.current.identity !== remoteIdentity) {
      if (automaticRetryRef.current.timer !== null) {
        window.clearTimeout(automaticRetryRef.current.timer);
      }
      automaticRetryRef.current = { identity: remoteIdentity, attempts: 0, timer: null };
    }

    if (
      ignoredRemoteRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= ignoredRemoteRevision
    ) {
      lastProcessedRemoteIdentity.current = remoteIdentity;
      isInitialSync.current = false;
      return;
    }
    if (
      outboxConflictRevision !== undefined
      && (remoteProgress.syncRevision ?? 0) <= outboxConflictRevision
    ) {
      lastProcessedRemoteIdentity.current = remoteIdentity;
      isInitialSync.current = false;
      const timeoutId = window.setTimeout(() => setSyncConflict(null), 0);
      return () => window.clearTimeout(timeoutId);
    }

    if (lastProcessedRemoteIdentity.current === remoteIdentity) return;
    if (jumpingRemoteIdentity.current === remoteIdentity) return;

    const retryState = automaticRetryRef.current;
    if (
      retryState.identity === remoteIdentity
      && retryState.attempts > 0
      && retryState.timer !== null
    ) return;

    // A different authoritative remote identity invalidates any slower jump.
    // Clear the old identity as well as its navigation generation so a late
    // blocked/stale result cannot dismiss a prompt created for the newer head.
    if (jumpingRemoteIdentity.current) jumpingRemoteIdentity.current = null;
    jumpGeneration.current += 1;

    const quietResumeEligible = isQuietResumeEligible();
    const isAutomaticNavigationRetry = retryState.identity === remoteIdentity
      && retryState.attempts > 0
      && retryState.timer === null
      && quietResumeEligible;
    const action = isAutomaticNavigationRetry
      ? 'jump'
      : decideRemoteProgressAction({
        isInitialSync: isInitialSync.current,
        operation: remoteOperation,
        hasLocalProgress,
        remoteAnchorCfi,
        currentAnchorCfi: currentAnchor,
        remoteTime,
        lastSaveTime: lastSaveTimeRef.current,
        remotePercent: remoteProgress.progressPercent,
        currentPercent: totalProgress,
        isQuietResumeEligible: quietResumeEligible,
        remoteRevision: remoteProgress.syncRevision,
        localRevision,
      });
    traceReaderBootstrap({
      event: 'remote-decision',
      identityHash: hashReaderTraceValue(remoteIdentity),
      revision: remoteProgress.syncRevision,
      decision: action,
    });
    if (action === 'ignore') {
      lastProcessedRemoteIdentity.current = remoteIdentity;
      isInitialSync.current = false;
      return;
    }

    const target: SyncConflict = {
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
      jumpingRemoteIdentity.current = remoteIdentity;
      void adoptAndNavigateRemoteProgress(target, 'quiet').then((result) => {
        traceReaderBootstrap({
          event: 'remote-navigation-result',
          identityHash: hashReaderTraceValue(remoteIdentity),
          revision: remoteProgress.syncRevision,
          status: result.status,
        });
        if (jumpingRemoteIdentity.current !== remoteIdentity) return;
        jumpingRemoteIdentity.current = null;
        if (
          result.status === 'navigated'
          || result.status === 'blocked-by-local-work'
          || result.status === 'stale-remote'
          || result.status === 'adopted-navigation-superseded'
        ) {
          lastProcessedRemoteIdentity.current = remoteIdentity;
          isInitialSync.current = false;
          setSyncConflictFeedback(null);
          if (
            result.status === 'blocked-by-local-work'
            || result.status === 'stale-remote'
          ) setSyncConflict(null);
          return;
        }

        const retryable = result.retryable;
        if (!retryable) {
          lastProcessedRemoteIdentity.current = remoteIdentity;
          isInitialSync.current = false;
          return;
        }
        const retryState = automaticRetryRef.current;
        if (retryState.identity !== remoteIdentity) return;
        retryState.attempts += 1;
        if (retryState.attempts <= 2) {
          const delay = retryState.attempts === 1 ? 750 : 2_000;
          retryState.timer = window.setTimeout(() => {
            if (automaticRetryRef.current.identity !== remoteIdentity) return;
            automaticRetryRef.current.timer = null;
            setRemoteRetryNonce((value) => value + 1);
          }, delay);
          return;
        }
        lastProcessedRemoteIdentity.current = remoteIdentity;
        isInitialSync.current = false;
        setSyncConflictFeedback('클라우드 위치는 저장됐지만 화면 이동에 실패했습니다. 다시 이동을 시도해 주세요.');
        setSyncConflict(target);
      });
      return;
    }

    let active = true;
    const timeoutId = window.setTimeout(() => {
      if (!active) return;
      // Only consume this head once the prompt is actually published. A
      // relocate before this timer fires must be free to schedule it again.
      lastProcessedRemoteIdentity.current = remoteIdentity;
      isInitialSync.current = false;
      setSyncConflictFeedback(null);
      setSyncConflict(target);
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [
    adoptAndNavigateRemoteProgress,
    currentAnchorCfi,
    currentCfi,
    hasLocalProgress,
    ignoredRemoteRevision,
    isLoaded,
    isQuietResumeEligible,
    lastSaveTimeRef,
    localRevision,
    outboxConflictRevision,
    remoteProgress,
    remoteRetryNonce,
    totalProgress,
  ]);

  const dismissSyncConflict = useCallback(async () => {
    if (syncConflict?.resolutionCommandId) {
      onResolvedRemoteProgressCancelled?.(syncConflict.resolutionCommandId);
      setSyncConflictFeedback(null);
      setSyncConflict(null);
      return;
    }
    if (syncConflict?.syncRevision) {
      const ignored = await onIgnoreRemoteProgress?.(syncConflict.syncRevision);
      if (!ignored) return;
    }
    setSyncConflictFeedback(null);
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
      ? async (signal?: AbortSignal) => {
        const result = await (onResolvedRemoteProgressFinalize?.(
          syncConflict.resolutionCommandId!,
          signal,
        ) ?? Promise.resolve({ status: 'cancelled' as const }));
        if (result.status === 'committed') finalizedProgress = result.progress;
        return result;
      }
      : undefined;
    if (!syncConflict.resolutionCommandId) {
      setSyncConflictFeedback(null);
      const targetIdentityHash = hashReaderTraceValue(getRemoteProgressIdentity({
        operation: target.operation,
        cfi: target.cfi,
        anchorCfi: target.anchorCfi,
        lastRead: target.lastRead,
        syncRevision: target.syncRevision,
        acceptedEventId: target.acceptedEventId,
      }));
      void adoptAndNavigateRemoteProgress(target).then((result) => {
        traceReaderBootstrap({
          event: 'remote-navigation-result',
          identityHash: targetIdentityHash,
          revision: target.syncRevision,
          status: result.status,
        });
        if (result.status === 'blocked-by-local-work') {
          setSyncConflictFeedback('현재 기기에서 방금 이동한 위치를 저장·동기화 중입니다. 저장이 끝난 뒤 다시 이동해 주세요.');
          return;
        }
        if (result.status === 'stale-remote') {
          setSyncConflictFeedback('클라우드 위치가 갱신되었습니다. 최신 동기화 상태를 확인한 뒤 다시 이동해 주세요.');
          return;
        }
        if (result.status === 'adopted-navigation-superseded') {
          setSyncConflictFeedback('이동 중 새 페이지 조작이 감지되어 원격 이동을 취소했습니다. 다시 이동해 주세요.');
          return;
        }
        if (result.status !== 'navigated') {
          setSyncConflictFeedback('화면 이동에 실패했습니다. 리더가 준비된 뒤 다시 시도해 주세요.');
          return;
        }
        const committedBookmarks = result.progress.bookmarks
          ?? target.bookmarks
          ?? getBookmarks();
        if (stagedBookmarks) commitBookmarks(committedBookmarks);
        adoptResolvedBookmarks(committedBookmarks);
        setSyncConflict(null);
      }).finally(() => setResolvingSyncConflict(false));
      return;
    }

    const jump = target.operation === 'reset'
      ? resetToRemoteProgress(target, { finalize })
      : jumpToRemoteProgress(target, { finalize });
    void jump.then((completed) => {
      if (!completed) return;
      const committedBookmarks = finalizedProgress?.bookmarks
        ?? target.bookmarks
        ?? getBookmarks();
      if (stagedBookmarks) commitBookmarks(committedBookmarks);
      adoptResolvedBookmarks(committedBookmarks);
      onResolvedRemoteProgressConsumed?.(syncConflict.resolutionCommandId!);
      setSyncConflict(null);
    }).finally(() => setResolvingSyncConflict(false));
  }, [adoptAndNavigateRemoteProgress, adoptResolvedBookmarks, commitBookmarks, currentAnchorCfi, currentCfi, getBookmarks, jumpToRemoteProgress, onResolvedRemoteProgressConsumed, onResolvedRemoteProgressFinalize, resetToRemoteProgress, resolvingSyncConflict, stageAutoBookmark, syncConflict, totalProgress]);

  return {
    syncConflict,
    syncConflictFeedback,
    resolvingSyncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  };
};
