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
import { deferSyncConflictV5 } from '../lib/syncOutboxV5';
import { subscribeProgressSyncWork } from '../lib/progressSyncWake';

export const useAnnotationSyncConflictResolution = ({
  user,
  ownerKey,
  activeBookId,
}: {
  user: FirebaseUser | null;
  ownerKey: string | null;
  activeBookId?: string;
}) => {
  const [conflict, setConflict] = useState<SyncConflictV5 | null>(null);
  const [resolving, setResolving] = useState(false);
  const generationRef = useRef(0);
  const resolvingRef = useRef(new Set<string>());

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
    setConflict(
      conflicts.find((candidate) => (
        candidate.event?.target.kind === 'annotation'
        && candidate.event.target.bookId === activeBookId
      ))
      ?? conflicts.find((candidate) => candidate.event?.target.kind === 'annotation')
      ?? conflicts[0]
      ?? null,
    );
  }, [activeBookId, user]);

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
    if (resolvingRef.current.has(conflict.conflictId)) return;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    try {
      await resolveAnnotationSyncConflictKeepLocalV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return;
      setConflict(null);
      await refresh();
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    if (resolvingRef.current.has(conflict.conflictId)) return;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    try {
      await resolveAnnotationSyncConflictUseRemoteV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return;
      setConflict(null);
      await refresh();
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  const defer = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return;
    if (resolvingRef.current.has(conflict.conflictId)) return;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    try {
      await deferSyncConflictV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return;
      setConflict(null);
      await refresh();
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  return { conflict, resolving, keepLocal, useRemote, defer };
};
