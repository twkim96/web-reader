import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import type { UserProgress } from '../types';
import {
  ownerRuntime,
  runForOwnerSnapshot,
  type OwnerSnapshot,
} from '../lib/ownerRuntime';
import {
  getOpenSyncConflictsV5,
  deferSyncConflictV5,
  resolveSyncConflictKeepLocalV5,
  resolveSyncConflictUseRemoteV5,
  type SyncConflictV5,
} from '../lib/syncOutboxV5';
import { getSyncOwnerKey } from '../lib/ownerIdentity';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';
import { rebaseProgressCommitBaseline } from '../lib/progressCommitBaseline';
import { getSyncSessionId } from '../lib/syncSession';
import { getQuietProgressConflictReason } from '../lib/syncConflictPolicy';
import type { ProgressPositionV2 } from '../lib/progressV2Schema';

type UseSyncConflictResolutionOptions = {
  user: FirebaseUser | null;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  ownerKey: string | null;
  activeBookId?: string;
  canQuietlyResolveProgressConflict?: () => boolean;
  canAutoResolveSettledProgressConflict?: () => boolean;
};

export type ResolvedRemoteProgressCommand = {
  commandId: string;
  operation: 'jump' | 'reset';
  progress: UserProgress;
};

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
  const [resolvedRemoteProgressCommand, setResolvedRemoteProgressCommand] = useState<
    ResolvedRemoteProgressCommand | null
  >(null);
  const resolvingRef = useRef(new Set<string>());
  const refreshGenerationRef = useRef(0);
  const sessionIdRef = useRef(getSyncSessionId());

  const applyRemote = useCallback(async (
    owner: OwnerSnapshot,
    target: SyncConflictV5,
    preserveLocalProgress: boolean,
    expectedLocalPosition?: ProgressPositionV2,
    canApplyRuntime?: () => boolean,
    emitRuntimeCommand = false,
  ) => {
    const nextProgress = await runForOwnerSnapshot(
      ownerRuntime,
      owner,
      () => resolveSyncConflictUseRemoteV5(
        getSyncOwnerKey(owner.ownerKey),
        target.conflictId,
        Date.now(),
        preserveLocalProgress,
        expectedLocalPosition,
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
      [nextProgress.bookId]: nextProgress,
    }) : prev);
    if (target.event?.target.kind === 'progress' && emitRuntimeCommand) {
      if (ownerRuntime.isCurrent(owner)) {
        setResolvedRemoteProgressCommand({
          commandId: crypto.randomUUID(),
          operation: target.remoteHead && 'position' in target.remoteHead
            && target.remoteHead.operation === 'reset'
            ? 'reset'
            : 'jump',
          progress: nextProgress,
        });
      }
    }
    return nextProgress;
  }, [progressRef, setProgress, setRemoteProgress]);

  const refresh = useCallback(async () => {
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const owner = ownerRuntime.capture();
    if (!user || !owner) {
      setConflict(null);
      return;
    }
    const conflicts = await getOpenSyncConflictsV5(getSyncOwnerKey(owner.ownerKey));
    if (!ownerRuntime.isCurrent(owner) || refreshGenerationRef.current !== generation) return;
    const next = conflicts.find((candidate) => (
      (candidate.event?.target.kind === 'progress' || candidate.event?.target.kind === 'bookmark')
    )) ?? null;
    const targetIsActiveBook = Boolean(
      next?.event?.target.kind === 'progress'
      && next.event.target.bookId === activeBookId,
    );
    const quietReason = next ? getQuietProgressConflictReason({
      conflict: next,
      activeBookId,
      currentSessionId: sessionIdRef.current,
    }) : null;
    const runtimeEligibility = quietReason === 'previous-session'
      ? canQuietlyResolveProgressConflict
      : canAutoResolveSettledProgressConflict;
    const readerCanAutoResolve = !targetIsActiveBook || runtimeEligibility?.() === true;
    const expectedLocalPosition = next?.latestLocalPosition
      && 'anchorCfi' in next.latestLocalPosition
      ? next.latestLocalPosition
      : undefined;
    if (next && readerCanAutoResolve && quietReason && expectedLocalPosition) {
      if (resolvingRef.current.has(next.conflictId)) return;
      resolvingRef.current.add(next.conflictId);
      try {
        const resolved = await applyRemote(
          owner,
          next,
          true,
          expectedLocalPosition,
          targetIsActiveBook ? runtimeEligibility : undefined,
          targetIsActiveBook,
        );
        if (!resolved) {
          const latestConflicts = await getOpenSyncConflictsV5(
            getSyncOwnerKey(owner.ownerKey),
          );
          if (ownerRuntime.isCurrent(owner) && refreshGenerationRef.current === generation) {
            setConflict(
              latestConflicts.find((candidate) => (
                (candidate.event?.target.kind === 'progress'
                  || candidate.event?.target.kind === 'bookmark')
              )) ?? null,
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
    applyRemote,
    canAutoResolveSettledProgressConflict,
    canQuietlyResolveProgressConflict,
    user,
  ]);

  useEffect(() => {
    setResolvedRemoteProgressCommand(null);
  }, [ownerKey]);

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
    if (!owner || !conflict) return;
    await resolveSyncConflictKeepLocalV5(getSyncOwnerKey(owner.ownerKey), conflict.conflictId);
    if (!ownerRuntime.isCurrent(owner)) return;
    setConflict(null);
    await refresh();
  }, [conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    await applyRemote(
      owner,
      conflict,
      conflict.event?.target.kind === 'progress',
      undefined,
      undefined,
      conflict.event?.target.kind === 'progress'
        && conflict.event.target.bookId === activeBookId,
    );
    if (!ownerRuntime.isCurrent(owner)) return;
    setConflict(null);
    await refresh();
  }, [activeBookId, applyRemote, conflict, refresh]);

  const defer = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    await deferSyncConflictV5(
      getSyncOwnerKey(owner.ownerKey),
      conflict.conflictId,
    );
    if (!ownerRuntime.isCurrent(owner)) return;
    setConflict(null);
    await refresh();
  }, [conflict, refresh]);

  const consumeResolvedRemoteProgressCommand = useCallback((commandId: string) => {
    setResolvedRemoteProgressCommand((current) => (
      current?.commandId === commandId ? null : current
    ));
  }, []);

  return {
    conflict,
    resolvedRemoteProgressCommand,
    consumeResolvedRemoteProgressCommand,
    keepLocal,
    useRemote,
    defer,
  };
};
