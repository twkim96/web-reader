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
  const [resolutionError, setResolutionError] = useState<string | null>(null);
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

  useEffect(() => {
    setResolutionError(null);
  }, [conflict?.conflictId, ownerKey]);

  const keepLocal = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return false;
    if (resolvingRef.current.has(conflict.conflictId)) return false;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      const result = await resolveAnnotationSyncConflictKeepLocalV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return false;
      if (!result) {
        await refresh();
        setResolutionError('원격 상태가 변경되었습니다. 최신 값을 다시 확인해 주세요.');
        return false;
      }
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[AnnotationSyncConflict] refresh after keep-local failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[AnnotationSyncConflict] keep-local resolution failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('현재 기기 값을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  const useRemote = useCallback(async () => {
    const owner = ownerRuntime.capture();
    if (!owner || !conflict) return false;
    if (resolvingRef.current.has(conflict.conflictId)) return false;
    resolvingRef.current.add(conflict.conflictId);
    setResolving(true);
    setResolutionError(null);
    try {
      const result = await resolveAnnotationSyncConflictUseRemoteV5(
        getSyncOwnerKey(owner.ownerKey),
        conflict.conflictId,
      );
      if (!ownerRuntime.isCurrent(owner)) return false;
      if (!result) {
        await refresh();
        setResolutionError('원격 상태가 변경되었습니다. 최신 값을 다시 확인해 주세요.');
        return false;
      }
      setConflict(null);
      await refresh().catch((error) => {
        console.error('[AnnotationSyncConflict] refresh after use-remote failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[AnnotationSyncConflict] use-remote resolution failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('원격 값을 적용하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

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
        console.error('[AnnotationSyncConflict] refresh after defer failed:', error);
      });
      return true;
    } catch (error) {
      console.error('[AnnotationSyncConflict] conflict deferral failed:', error);
      if (ownerRuntime.isCurrent(owner)) {
        setResolutionError('충돌을 나중으로 미루지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return false;
    } finally {
      resolvingRef.current.delete(conflict.conflictId);
      if (ownerRuntime.isCurrent(owner)) setResolving(false);
    }
  }, [conflict, refresh]);

  return { conflict, resolving, resolutionError, keepLocal, useRemote, defer };
};
