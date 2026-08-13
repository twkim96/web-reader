import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import type { RemoteProgressUpdate, UserProgress } from '../types';
import {
  ownerRuntime,
  runForOwnerSnapshot,
  type OwnerSnapshot,
} from '../lib/ownerRuntime';
import {
  getOpenSyncConflictsV5,
  getUnresolvedSyncConflictsV5,
  isSyncConflictPresentableV5,
  deferSyncConflictV5,
  previewSyncConflictUseRemoteProgressV5,
  resolveSyncConflictKeepLocalV5,
  resolveSyncConflictUseRemoteV5,
  type ExpectedLocalProgressStateV5,
  type ExpectedRemoteProgressHeadV5,
  type SyncConflictV5,
  type SyncOutboxEventV5,
} from '../lib/syncOutboxV5';
import { getSyncOwnerKey } from '../lib/ownerIdentity';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';
import { rebaseProgressCommitBaseline } from '../lib/progressCommitBaseline';
import { getSyncSessionId } from '../lib/syncSession';
import { getAutomaticProgressConflictResolution } from '../lib/syncConflictPolicy';
import { selectProgressSyncConflict } from '../lib/syncConflictPresentation';
import {
  hasSameExpectedLocalProgressState,
  hasSameRemoteProgressHead,
} from './reader/remoteProgressCommand';

type UseSyncConflictResolutionOptions = {
  user: FirebaseUser | null;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, RemoteProgressUpdate>>>;
  ownerKey: string | null;
  activeBookId?: string;
  canQuietlyResolveProgressConflict?: () => boolean;
  canAutoResolveSettledProgressConflict?: () => boolean;
};

export type ResolvedRemoteProgressCommand = {
  commandId: string;
  conflictId: string;
  operation: 'jump' | 'reset';
  progress: UserProgress;
  expectedLocalState: ExpectedLocalProgressStateV5;
  expectedRemoteHead: ExpectedRemoteProgressHeadV5;
  conflict: SyncConflictV5;
  committed?: boolean;
};

export type RemoteProgressCommandFinalizeResult =
  | { status: 'committed'; progress: UserProgress }
  | { status: 'stale'; restart: () => void }
  | { status: 'local-changed' }
  | { status: 'cancelled' };

export const useSyncConflictResolution = ({
  user,
  progressRef,
  setProgress,
  setRemoteProgress,
  ownerKey,
  activeBookId,
  canQuietlyResolveProgressConflict,
  canAutoResolveSettledProgressConflict,
}: UseSyncConflictResolutionOptions) => {
  const [conflict, setConflict] = useState<SyncConflictV5 | null>(null);
  const [activeProgressConflictRevision, setActiveProgressConflictRevision] = useState<
    number | undefined
  >(undefined);
  const [resolving, setResolving] = useState(false);
  const [resolutionError, setResolutionError] = useState<string | null>(null);
  const [resolvedRemoteProgressCommand, setResolvedRemoteProgressCommand] = useState<
    ResolvedRemoteProgressCommand | null
  >(null);
  const resolvedRemoteProgressCommandRef = useRef<ResolvedRemoteProgressCommand | null>(null);
  const remoteProgressCommandAbortRef = useRef(new Map<string, AbortController>());
  const resolvingRef = useRef(new Set<string>());
  const refreshGenerationRef = useRef(0);
  const sessionIdRef = useRef(getSyncSessionId());

  const stageRemoteProgressCommand = useCallback((
    target: SyncConflictV5,
    progress: UserProgress,
    expectedLocalState: ExpectedLocalProgressStateV5,
    expectedRemoteHead: ExpectedRemoteProgressHeadV5,
    committed = false,
  ) => {
    const previousCommandId = resolvedRemoteProgressCommandRef.current?.commandId;
    if (previousCommandId) {
      remoteProgressCommandAbortRef.current.get(previousCommandId)?.abort();
      remoteProgressCommandAbortRef.current.delete(previousCommandId);
    }
    const command: ResolvedRemoteProgressCommand = {
      commandId: crypto.randomUUID(),
      conflictId: target.conflictId,
      operation: target.remoteHead && 'position' in target.remoteHead
        && target.remoteHead.operation === 'reset'
        ? 'reset'
        : 'jump',
      progress,
      expectedLocalState,
      expectedRemoteHead,
      conflict: target,
      ...(committed ? { committed: true } : {}),
    };
    remoteProgressCommandAbortRef.current.set(command.commandId, new AbortController());
    resolvedRemoteProgressCommandRef.current = command;
    setResolvedRemoteProgressCommand(command);
    return command;
  }, []);

  const applyLocalProgressWinnerToRuntime = useCallback((
    owner: OwnerSnapshot,
    target: SyncConflictV5,
    replacement: SyncOutboxEventV5,
  ) => {
    if (
      !ownerRuntime.isCurrent(owner)
      || target.event?.target.kind !== 'progress'
      || replacement.target.kind !== 'progress'
      || !target.remoteHead
      || !('position' in target.remoteHead)
    ) return;

    const bookId = target.event.target.bookId;
    const ignoredRevision = target.remoteHead.revision;
    const existing = progressRef.current[bookId];
    if (existing) {
      const nextProgress: UserProgress = {
        ...existing,
        ignoredRemoteRevision: Math.max(
          existing.ignoredRemoteRevision ?? 0,
          ignoredRevision,
        ),
      };
      rebaseProgressCommitBaseline(owner.ownerKey, bookId, nextProgress);
      progressRef.current = { ...progressRef.current, [bookId]: nextProgress };
      setProgress((prev) => ownerRuntime.isCurrent(owner)
        ? { ...prev, [bookId]: nextProgress }
        : prev);
    }
    setRemoteProgress((prev) => {
      if (!ownerRuntime.isCurrent(owner)) return prev;
      const staleRemote = prev[bookId];
      if (
        !staleRemote
        || !Number.isSafeInteger(staleRemote.syncRevision)
        || staleRemote.syncRevision! > ignoredRevision
      ) return prev;
      const next = { ...prev };
      delete next[bookId];
      return next;
    });
  }, [progressRef, setProgress, setRemoteProgress]);

  const applyRemote = useCallback(async (
    owner: OwnerSnapshot,
    target: SyncConflictV5,
    preserveLocalProgress: boolean,
    expectedLocalState?: ExpectedLocalProgressStateV5,
    canApplyRuntime?: () => boolean,
    emitRuntimeCommand = false,
    expectedRemoteHead?: ExpectedRemoteProgressHeadV5,
    signal?: AbortSignal,
  ) => {
    const nextProgress = await runForOwnerSnapshot(
      ownerRuntime,
      owner,
      () => resolveSyncConflictUseRemoteV5(
        getSyncOwnerKey(owner.ownerKey),
        target.conflictId,
        Date.now(),
        preserveLocalProgress,
        expectedLocalState,
        expectedRemoteHead,
        signal,
      ),
    );
    if (!nextProgress) return null;
    if (canApplyRuntime && !canApplyRuntime()) return nextProgress;
    rebaseProgressCommitBaseline(owner.ownerKey, nextProgress.bookId, nextProgress);
    setProgress((prev) => {
      if (!ownerRuntime.isCurrent(owner)) return prev;
      const next = { ...prev, [nextProgress.bookId]: nextProgress };
      progressRef.current = next;
      return next;
    });
    setRemoteProgress((prev) => ownerRuntime.isCurrent(owner) ? ({
      ...prev,
      [nextProgress.bookId]: {
        ...nextProgress,
        operation: target.remoteHead && 'position' in target.remoteHead
          ? target.remoteHead.operation
          : 'set',
      },
    }) : prev);
    if (
      target.event?.target.kind === 'progress'
      && emitRuntimeCommand
      && target.remoteHead
      && 'position' in target.remoteHead
    ) {
      if (ownerRuntime.isCurrent(owner)) {
        stageRemoteProgressCommand(
          target,
          nextProgress,
          expectedLocalState ?? { kind: 'empty' },
          {
            revision: target.remoteHead.revision,
            acceptedEventId: target.remoteHead.acceptedEventId,
            operation: target.remoteHead.operation,
            position: target.remoteHead.position,
          },
          true,
        );
      }
    }
    return nextProgress;
  }, [progressRef, setProgress, setRemoteProgress, stageRemoteProgressCommand]);

  const refresh = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const owner = ownerRuntime.capture();
    if (!user || !owner) {
      setConflict(null);
      setActiveProgressConflictRevision(undefined);
      return;
    }
    const unresolvedConflicts = await getUnresolvedSyncConflictsV5(
      getSyncOwnerKey(owner.ownerKey),
    );
    if (!ownerRuntime.isCurrent(owner) || refreshGenerationRef.current !== generation) return;
    const conflicts = unresolvedConflicts.filter((candidate) => (
      isSyncConflictPresentableV5(candidate)
    ));
    const next = selectProgressSyncConflict(conflicts, activeBookId);
    const activeProgressConflict = unresolvedConflicts.find((candidate) => (
      candidate.event?.target.kind === 'progress'
      && candidate.event.target.bookId === activeBookId
    ));
    setActiveProgressConflictRevision(
      activeProgressConflict?.remoteHead
      && 'position' in activeProgressConflict.remoteHead
        ? activeProgressConflict.remoteHead.revision
        : undefined,
    );
    const targetIsActiveBook = Boolean(
      next?.event?.target.kind === 'progress'
      && next.event.target.bookId === activeBookId,
    );
    const automaticResolution = next ? getAutomaticProgressConflictResolution({
      conflict: next,
      activeBookId,
      currentSessionId: sessionIdRef.current,
    }) : null;
    const runtimeEligibility = automaticResolution?.reason === 'previous-session'
      ? canQuietlyResolveProgressConflict
      : canAutoResolveSettledProgressConflict;
    const readerCanAutoResolve = !targetIsActiveBook || runtimeEligibility?.() === true;
    const expectedLocalPosition = next?.latestLocalPosition
      && 'anchorCfi' in next.latestLocalPosition
      ? next.latestLocalPosition
      : undefined;
    if (next && readerCanAutoResolve && automaticResolution && expectedLocalPosition) {
      if (resolvingRef.current.has(next.conflictId)) return;
      resolvingRef.current.add(next.conflictId);
      try {
        if (automaticResolution.winner === 'local') {
          const replacement = await resolveSyncConflictKeepLocalV5(
            getSyncOwnerKey(owner.ownerKey),
            next.conflictId,
          );
          if (!ownerRuntime.isCurrent(owner)) return;
          if (!replacement) {
            const latestConflicts = await getOpenSyncConflictsV5(
              getSyncOwnerKey(owner.ownerKey),
            );
            if (ownerRuntime.isCurrent(owner) && refreshGenerationRef.current === generation) {
              setConflict(selectProgressSyncConflict(latestConflicts, activeBookId));
            }
            return;
          }
          applyLocalProgressWinnerToRuntime(owner, next, replacement);
          setConflict(null);
          return;
        }
        if (targetIsActiveBook
          && resolvedRemoteProgressCommandRef.current?.conflictId === next.conflictId) return;
        const expectedRemoteHead = next.remoteHead && 'position' in next.remoteHead
          ? {
            revision: next.remoteHead.revision,
            acceptedEventId: next.remoteHead.acceptedEventId,
            operation: next.remoteHead.operation,
            position: next.remoteHead.position,
          }
          : undefined;
        const resolved = await applyRemote(
          owner,
          next,
          true,
          { kind: 'position', position: expectedLocalPosition },
          targetIsActiveBook ? runtimeEligibility : undefined,
          targetIsActiveBook,
          expectedRemoteHead,
        );
        if (!resolved) {
          const latestConflicts = await getOpenSyncConflictsV5(
            getSyncOwnerKey(owner.ownerKey),
          );
          if (ownerRuntime.isCurrent(owner) && refreshGenerationRef.current === generation) {
            setConflict(
              selectProgressSyncConflict(latestConflicts, activeBookId),
            );
          }
          return;
        }
        if (ownerRuntime.isCurrent(owner)) setConflict(null);
      } catch (error) {
        console.error('[SyncConflict] automatic progress resolution failed:', error);
        if (ownerRuntime.isCurrent(owner)) setConflict(next);
      } finally {
        resolvingRef.current.delete(next.conflictId);
      }
      return;
    }
    setConflict(next);
  }, [
    activeBookId,
    applyLocalProgressWinnerToRuntime,
    applyRemote,
    canAutoResolveSettledProgressConflict,
    canQuietlyResolveProgressConflict,
    user,
  ]);

  useEffect(() => {
    for (const controller of remoteProgressCommandAbortRef.current.values()) {
      controller.abort();
    }
    remoteProgressCommandAbortRef.current.clear();
    resolvedRemoteProgressCommandRef.current = null;
    setResolvedRemoteProgressCommand(null);
  }, [ownerKey]);

  useEffect(() => {
    setResolutionError(null);
  }, [conflict?.conflictId, ownerKey]);

  useEffect(() => {
    const owner = ownerRuntime.capture();
    const syncOwnerKey = owner ? getSyncOwnerKey(owner.ownerKey) : null;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const unsubscribeWork = syncOwnerKey
      ? subscribeProgressSyncWork(syncOwnerKey, () => void refresh())
      : () => undefined;
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      refreshGenerationRef.current += 1;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      unsubscribeWork();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [ownerKey, refresh]);

  const keepLocal = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return false;
    if (resolvingRef.current.has(conflict.conflictId)) return false;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      const replacement = await resolveSyncConflictKeepLocalV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return false;
      if (!replacement) {
        await refresh();
        setResolutionError('원격 상태가 변경되었습니다. 최신 값을 다시 확인해 주세요.');
        return false;
      }
      applyLocalProgressWinnerToRuntime(owner, conflict, replacement);
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[SyncConflict] refresh after keep-local failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[SyncConflict] keep-local resolution failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('현재 기기 값을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [applyLocalProgressWinnerToRuntime, conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return false;
    if (resolvingRef.current.has(conflict.conflictId)) return false;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      if (
        conflict.event?.target.kind === 'progress'
        && conflict.event.target.bookId === activeBookId
      ) {
        const preview = await previewSyncConflictUseRemoteProgressV5(
          getSyncOwnerKey(owner.ownerKey),
          conflict.conflictId,
          Date.now(),
          true,
        );
        if (!preview || !ownerRuntime.isCurrent(owner)) {
          setResolutionError('충돌 상태가 바뀌었습니다. 다시 확인해 주세요.');
          return false;
        }
        stageRemoteProgressCommand(
          preview.conflict,
          preview.progress,
          preview.expectedLocalState,
          preview.expectedRemoteHead,
        );
        setConflict(preview.conflict);
        return true;
      }
      const resolved = await applyRemote(
        owner,
        conflict,
        conflict.event?.target.kind === 'progress',
        undefined,
        undefined,
        conflict.event?.target.kind === 'progress'
          && conflict.event.target.bookId === activeBookId,
      );
      if (!ownerRuntime.isCurrent(owner)) return false;
      if (!resolved) {
        await refresh();
        setResolutionError('원격 상태가 변경되었습니다. 최신 값을 다시 확인해 주세요.');
        return false;
      }
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[SyncConflict] refresh after use-remote failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[SyncConflict] use-remote resolution failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('원격 값을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [activeBookId, applyRemote, conflict, refresh, stageRemoteProgressCommand]);

  const defer = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return false;
    if (resolvingRef.current.has(conflict.conflictId)) return false;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      await deferSyncConflictV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return false;
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[SyncConflict] refresh after defer failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[SyncConflict] conflict deferral failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('충돌을 나중으로 미루지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  const consumeResolvedRemoteProgressCommand = useCallback((commandId: string) => {
    remoteProgressCommandAbortRef.current.get(commandId)?.abort();
    remoteProgressCommandAbortRef.current.delete(commandId);
    if (resolvedRemoteProgressCommandRef.current?.commandId === commandId) {
      resolvedRemoteProgressCommandRef.current = null;
    }
    setResolvedRemoteProgressCommand((current) => (
      current?.commandId === commandId ? null : current
    ));
  }, []);

  const finalizeResolvedRemoteProgressCommand = useCallback(async (
    commandId: string,
  ): Promise<RemoteProgressCommandFinalizeResult> => {
    const command = resolvedRemoteProgressCommandRef.current;
    const owner = ownerRuntime.capture();
    if (!owner || !command || command.commandId !== commandId) {
      return { status: 'cancelled' };
    }
    const controller = remoteProgressCommandAbortRef.current.get(commandId);
    if (!controller || controller.signal.aborted) return { status: 'cancelled' };
    if (resolvingRef.current.has(command.conflictId)) return { status: 'cancelled' };
    resolvingRef.current.add(command.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      const resolved = await applyRemote(
        owner,
        command.conflict,
        true,
        command.expectedLocalState,
        undefined,
        false,
        command.expectedRemoteHead,
        controller.signal,
      );
      if (!ownerRuntime.isCurrent(owner)) return { status: 'cancelled' };
      if (!resolved) {
        if (resolvedRemoteProgressCommandRef.current?.commandId !== commandId) {
          return { status: 'cancelled' };
        }
        const latestConflicts = await getOpenSyncConflictsV5(
          getSyncOwnerKey(owner.ownerKey),
        );
        if (!ownerRuntime.isCurrent(owner)) return { status: 'cancelled' };
        const latest = latestConflicts.find((candidate) => (
          candidate.conflictId === command.conflictId
        ));
        if (latest && hasSameRemoteProgressHead(latest, command.conflict)) {
          await refresh();
          setResolutionError('현재 기기의 읽기 위치가 변경되어 원격 이동을 확정하지 않았습니다.');
          return { status: 'local-changed' };
        }
        if (latest?.event?.target.kind === 'progress') {
          const preview = await previewSyncConflictUseRemoteProgressV5(
            getSyncOwnerKey(owner.ownerKey),
            latest.conflictId,
            Date.now(),
            true,
          );
          if (preview && ownerRuntime.isCurrent(owner)) {
            if (!hasSameExpectedLocalProgressState(
              preview.expectedLocalState,
              command.expectedLocalState,
            )) {
              await refresh();
              setResolutionError('현재 기기의 읽기 위치가 변경되어 원격 이동을 확정하지 않았습니다.');
              return { status: 'local-changed' };
            }
            return {
              status: 'stale',
              restart: () => {
                if (
                  !ownerRuntime.isCurrent(owner)
                  || resolvedRemoteProgressCommandRef.current?.commandId !== commandId
                ) return;
                stageRemoteProgressCommand(
                  preview.conflict,
                  preview.progress,
                  preview.expectedLocalState,
                  preview.expectedRemoteHead,
                );
                setConflict(preview.conflict);
                setResolutionError('원격 위치가 다시 변경되어 최신 위치로 이동을 다시 준비합니다.');
              },
            };
          }
        }
        await refresh();
        setResolutionError('원격 충돌 상태가 변경되어 이동을 확정하지 않았습니다.');
        return { status: 'cancelled' };
      }
      consumeResolvedRemoteProgressCommand(commandId);
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[SyncConflict] refresh after remote navigation finalize failed:', error);
      });
      return { status: 'committed', progress: resolved };
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' };
      console.error('[SyncConflict] remote navigation finalize failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('이동 중 읽기 위치가 다시 변경되어 원격 값을 확정하지 않았습니다.');
      }
      return { status: 'cancelled' };
    } finally {
      resolvingRef.current.delete(command.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [
    applyRemote,
    consumeResolvedRemoteProgressCommand,
    refresh,
    stageRemoteProgressCommand,
  ]);

  const cancelResolvedRemoteProgressCommand = useCallback((commandId: string) => {
    consumeResolvedRemoteProgressCommand(commandId);
    setResolutionError('원격 위치 이동이 취소되어 충돌을 해결하지 않았습니다.');
  }, [consumeResolvedRemoteProgressCommand]);

  return {
    conflict,
    resolving,
    resolutionError,
    activeProgressConflictRevision,
    resolvedRemoteProgressCommand,
    consumeResolvedRemoteProgressCommand,
    finalizeResolvedRemoteProgressCommand,
    cancelResolvedRemoteProgressCommand,
    keepLocal,
    useRemote,
    defer,
  };
};
