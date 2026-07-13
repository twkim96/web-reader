import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import type { UserProgress } from '../types';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getOpenSyncConflictsV5,
  resolveSyncConflictKeepLocalV5,
  resolveSyncConflictUseRemoteV5,
  type SyncConflictV5,
} from '../lib/syncOutboxV5';
import { getSyncOwnerKey } from '../lib/ownerIdentity';

type UseSyncConflictResolutionOptions = {
  user: FirebaseUser | null;
  progressRef: MutableRefObject<Record<string, UserProgress>>;
  setProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  setRemoteProgress: Dispatch<SetStateAction<Record<string, UserProgress>>>;
  ownerKey: string | null;
};

export const useSyncConflictResolution = ({
  user,
  progressRef,
  setProgress,
  setRemoteProgress,
  ownerKey,
}: UseSyncConflictResolutionOptions) => {
  const [conflict, setConflict] = useState<SyncConflictV5 | null>(null);
  const dismissedRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!user || !owner) {
      setConflict(null);
      return;
    }
    const conflicts = await getOpenSyncConflictsV5(getSyncOwnerKey(owner.ownerKey));
    if (!ownerRuntime.isCurrent(owner)) return;
    const next = conflicts.find((candidate) => !dismissedRef.current.has(candidate.conflictId)) ?? null;
    setConflict(next);
  }, [user]);

  useEffect(() => {
    dismissedRef.current.clear();
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 1_500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [ownerKey, refresh]);

  const keepLocal = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    await resolveSyncConflictKeepLocalV5(getSyncOwnerKey(owner.ownerKey), conflict.conflictId);
    setConflict(null);
    await refresh();
  }, [conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    const nextProgress = await resolveSyncConflictUseRemoteV5(
      getSyncOwnerKey(owner.ownerKey),
      conflict.conflictId,
    );
    if (!ownerRuntime.isCurrent(owner)) return;
    setProgress((prev) => {
      const next = { ...prev, [nextProgress.bookId]: nextProgress };
      progressRef.current = next;
      return next;
    });
    setRemoteProgress((prev) => ({
      ...prev,
      [nextProgress.bookId]: nextProgress,
    }));
    setConflict(null);
    await refresh();
  }, [conflict, progressRef, refresh, setProgress, setRemoteProgress]);

  const defer = useCallback(() => {
    if (!conflict) return;
    dismissedRef.current.add(conflict.conflictId);
    setConflict(null);
  }, [conflict]);

  return { conflict, keepLocal, useRemote, defer };
};
