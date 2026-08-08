'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { User as FirebaseUser } from 'firebase/auth';
import { ownerRuntime } from '../lib/ownerRuntime';
import { getSyncOwnerKey } from '../lib/ownerIdentity';
import {
  getOpenAnnotationSyncConflictsV5,
  resolveAnnotationSyncConflictKeepLocalV5,
  resolveAnnotationSyncConflictUseRemoteV5,
} from '../lib/annotationSyncConflict';
import type { SyncConflictV5 } from '../lib/syncOutboxV5';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';

export const useAnnotationSyncConflictResolution = ({
  user,
  ownerKey,
}: {
  user: FirebaseUser | null;
  ownerKey: string | null;
}) => {
  const [conflict, setConflict] = useState<SyncConflictV5 | null>(null);
  const dismissedRef = useRef(new Set<string>());
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const owner = ownerRuntime.capture();
    if (!user || !owner) {
      setConflict(null);
      return;
    }
    const conflicts = await getOpenAnnotationSyncConflictsV5(
      getSyncOwnerKey(owner.ownerKey),
    );
    if (!ownerRuntime.isCurrent(owner) || generationRef.current !== generation) return;
    setConflict(conflicts.find(({ conflictId }) => (
      !dismissedRef.current.has(conflictId)
    )) ?? null);
  }, [user]);

  useEffect(() => {
    dismissedRef.current.clear();
    const owner = ownerRuntime.capture();
    const syncOwnerKey = owner ? getSyncOwnerKey(owner.ownerKey) : null;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const unsubscribe = syncOwnerKey
      ? subscribeProgressSyncWork(syncOwnerKey, () => void refresh())
      : () => undefined;
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      generationRef.current += 1;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [ownerKey, refresh]);

  const keepLocal = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    await resolveAnnotationSyncConflictKeepLocalV5(
      getSyncOwnerKey(owner.ownerKey),
      conflict.conflictId,
    );
    if (!ownerRuntime.isCurrent(owner)) return;
    setConflict(null);
    await refresh();
  }, [conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    await resolveAnnotationSyncConflictUseRemoteV5(
      getSyncOwnerKey(owner.ownerKey),
      conflict.conflictId,
    );
    if (!ownerRuntime.isCurrent(owner)) return;
    setConflict(null);
    await refresh();
  }, [conflict, refresh]);

  const defer = useCallback(() => {
    if (!conflict) return;
    dismissedRef.current.add(conflict.conflictId);
    setConflict(null);
  }, [conflict]);

  return { conflict, keepLocal, useRemote, defer };
};
