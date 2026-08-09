'use client';

import { useEffect, useRef, useState } from 'react';
import { onIdTokenChanged } from 'firebase/auth';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
} from 'firebase/firestore';
import type { AnnotationPaletteItem } from '../types';
import { auth, db } from '../lib/firebase';
import { APP_ID } from '../lib/appIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import {
  getSyncOwnerKey,
  splitOwnerKey,
  type OwnerKey,
} from '../lib/ownerIdentity';
import {
  getFirebaseAnnotationPalettePath,
  getFirebaseAnnotationSyncPath,
  parseAnnotationHeadV1,
  parseAnnotationPaletteHeadV1,
  toAnnotationSyncSchemaError,
  type AnnotationHeadV1,
} from '../lib/annotationSyncSchema';
import {
  enqueueMissingLocalAnnotationsV5,
  enqueueMissingLocalAnnotationPaletteV5,
  getCachedRemoteAnnotationHeadsV5,
  getLocalAnnotationIdsV8,
  hydrateRemoteAnnotationHeadsV5,
} from '../lib/annotationSyncLocal';
import { getAuthoritativeRemoteAnnotationHeadV1 } from '../lib/annotationSyncRemote';
import {
  hasActiveSyncTargetWorkV5,
  storeRemoteHeadsBatchV5,
  type AnnotationSyncContextV5,
} from '../lib/syncOutboxV5';
import { annotationPaletteTargetKeyV1 } from '../lib/annotationSyncSchema';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from '../lib/annotationPolicy';
import { ServerSnapshotHydrator } from '../lib/serverSnapshotHydrator';
import { SnapshotListenerRecovery } from '../lib/snapshotListenerRecovery';
import { mergeSyncHealth, type SyncHealth } from '../lib/syncHealth';
import { isExactSyncSessionEcho } from '../lib/syncSession';
import {
  notifyAnnotationSyncChange,
  subscribeAnnotationSyncChanges,
} from '../lib/annotationSyncWake';

type FirestoreQuerySnapshot = QuerySnapshot<DocumentData, DocumentData>;
type FirestoreDocumentSnapshot = DocumentSnapshot<DocumentData, DocumentData>;

type UseAnnotationSyncOptions = {
  ownerKey: OwnerKey;
  bookId: string;
  context?: AnnotationSyncContextV5;
  palette: AnnotationPaletteItem[];
  applyRemotePalette: (value: unknown) => Promise<AnnotationPaletteItem[]>;
};

export const useAnnotationSync = ({
  ownerKey,
  bookId,
  context,
  palette,
  applyRemotePalette,
}: UseAnnotationSyncOptions) => {
  const [annotationRevision, setAnnotationRevision] = useState(0);
  const [annotationHealth, setAnnotationHealth] = useState<SyncHealth>('healthy');
  const [markerHealth, setMarkerHealth] = useState<SyncHealth>('healthy');
  const [paletteHealth, setPaletteHealth] = useState<SyncHealth>('healthy');
  const annotationRecoveryRef = useRef<SnapshotListenerRecovery<FirestoreQuerySnapshot> | null>(null);
  const markerRecoveryRef = useRef<SnapshotListenerRecovery<FirestoreDocumentSnapshot> | null>(null);
  const paletteRecoveryRef = useRef<SnapshotListenerRecovery<FirestoreDocumentSnapshot> | null>(null);
  const paletteRef = useRef(palette);

  useEffect(() => {
    paletteRef.current = palette;
  }, [palette]);

  useEffect(() => subscribeAnnotationSyncChanges(ownerKey, (change) => {
    if (change.bookId === bookId) {
      setAnnotationRevision((current) => current + 1);
    }
  }), [bookId, ownerKey]);

  useEffect(() => {
    if (!context) {
      const resetHealth = window.setTimeout(() => {
        setAnnotationHealth('healthy');
        setMarkerHealth('healthy');
      }, 0);
      return () => window.clearTimeout(resetHealth);
    }
    const owner = ownerRuntime.capture();
    if (!owner || owner.ownerKey !== ownerKey) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (!authOwnerKey.startsWith('firebase:')) return;
    const uid = authOwnerKey.slice('firebase:'.length);
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const basePath = getFirebaseAnnotationSyncPath(APP_ID, uid);
    const annotationsRef = query(
      collection(db, `${basePath}/${bookId}/annotations`),
      where('operation', '==', 'upsert'),
    );
    const markerDocumentRef = doc(
      db,
      `${basePath}/${bookId}/annotations/${ANNOTATION_BOOK_DELETE_MARKER_ID}`,
    );
    let disposed = false;
    const controller = new AbortController();
    const isCurrent = () => !disposed && ownerRuntime.isCurrent(owner);
    let hydrator = new ServerSnapshotHydrator<
      QueryDocumentSnapshot<DocumentData, DocumentData>
    >();
    let remoteHeads = new Map<string, AnnotationHeadV1>();
    let authoritativeSeen = false;
    let resolveMarkerAuthoritative: () => void = () => undefined;
    const markerAuthoritativeReady = new Promise<void>((resolve) => {
      resolveMarkerAuthoritative = resolve;
    });

    const handleSnapshot = async (snapshot: FirestoreQuerySnapshot) => {
      if (!isCurrent()) return;
      const changes = hydrator.select(snapshot);
      if (!changes) return;
      const firstAuthoritativeSnapshot = !authoritativeSeen;
      authoritativeSeen = true;
      const missingRemoteIds = new Set<string>();
      for (const change of changes) {
        if (change.doc.metadata.hasPendingWrites) continue;
        if (change.type === 'removed') {
          remoteHeads.delete(change.doc.id);
          missingRemoteIds.add(change.doc.id);
          continue;
        }
        let head: AnnotationHeadV1;
        try {
          head = parseAnnotationHeadV1(change.doc.data());
        } catch (error) {
          throw toAnnotationSyncSchemaError(error);
        }
        if (head.bookId !== bookId || head.annotationId !== change.doc.id) {
          throw toAnnotationSyncSchemaError(
            new Error('annotation snapshot identity가 올바르지 않습니다.'),
          );
        }
        remoteHeads.set(head.annotationId, head);
      }
      if (firstAuthoritativeSnapshot) {
        const [cachedHeads, localAnnotationIds] = await Promise.all([
          getCachedRemoteAnnotationHeadsV5(syncOwnerKey, bookId),
          getLocalAnnotationIdsV8(syncOwnerKey, bookId),
        ]);
        for (const head of cachedHeads) {
          if (
            head.operation === 'upsert'
            && !remoteHeads.has(head.annotationId)
          ) missingRemoteIds.add(head.annotationId);
        }
        for (const annotationId of localAnnotationIds) {
          if (!remoteHeads.has(annotationId)) missingRemoteIds.add(annotationId);
        }
      }
      const missingHeads: AnnotationHeadV1[] = [];
      const missingIds = [...missingRemoteIds];
      for (let offset = 0; offset < missingIds.length; offset += 8) {
        const batch = await Promise.all(missingIds.slice(offset, offset + 8).map((annotationId) => (
          getAuthoritativeRemoteAnnotationHeadV1(uid, bookId, annotationId)
        )));
        for (const head of batch) {
          if (head) missingHeads.push(head);
        }
      }
      for (const head of missingHeads) {
        if (head.operation === 'upsert') remoteHeads.set(head.annotationId, head);
      }
      const result = await hydrateRemoteAnnotationHeadsV5(
        syncOwnerKey,
        bookId,
        [
          ...remoteHeads.values(),
          ...missingHeads.filter(({ operation }) => operation === 'delete'),
        ],
        context.sessionId,
        Date.now(),
        isCurrent,
        controller.signal,
      );
      if (firstAuthoritativeSnapshot && isCurrent()) {
        await markerAuthoritativeReady;
        if (!isCurrent()) return;
        await enqueueMissingLocalAnnotationsV5(
          syncOwnerKey,
          bookId,
          new Set(remoteHeads.keys()),
          context,
          isCurrent,
          controller.signal,
        );
      }
      if (result.changed && isCurrent()) {
        notifyAnnotationSyncChange({ ownerKey, bookId });
      }
    };

    const recovery = new SnapshotListenerRecovery<FirestoreQuerySnapshot>({
      subscribe: (next, error) => {
        hydrator = new ServerSnapshotHydrator();
        remoteHeads = new Map();
        authoritativeSeen = false;
        return onSnapshot(annotationsRef, { includeMetadataChanges: true }, next, error);
      },
      onSnapshot: handleSnapshot,
      isAuthoritative: (snapshot) => !snapshot.metadata.fromCache,
      onHealthChange: setAnnotationHealth,
      onError: (error) => console.error('[AnnotationSync] listener failed:', error),
      canRetry: () => navigator.onLine,
    });
    annotationRecoveryRef.current = recovery;

    const markerRecovery = new SnapshotListenerRecovery<FirestoreDocumentSnapshot>({
      subscribe: (next, error) => onSnapshot(
        markerDocumentRef,
        { includeMetadataChanges: true },
        next,
        error,
      ),
      onSnapshot: async (snapshot) => {
        if (!isCurrent() || snapshot.metadata.fromCache) return;
        if (!snapshot.exists()) {
          resolveMarkerAuthoritative();
          return;
        }
        let head: AnnotationHeadV1;
        try {
          head = parseAnnotationHeadV1(snapshot.data());
        } catch (error) {
          throw toAnnotationSyncSchemaError(error);
        }
        if (
          head.bookId !== bookId
          || head.annotationId !== ANNOTATION_BOOK_DELETE_MARKER_ID
          || head.operation !== 'delete'
        ) throw toAnnotationSyncSchemaError(
          new Error('annotation 삭제 marker가 올바르지 않습니다.'),
        );
        await storeRemoteHeadsBatchV5(syncOwnerKey, [head]);
        resolveMarkerAuthoritative();
      },
      isAuthoritative: (snapshot) => !snapshot.metadata.fromCache,
      onHealthChange: setMarkerHealth,
      onError: (error) => console.error('[AnnotationSync] marker listener failed:', error),
      canRetry: () => navigator.onLine,
    });
    markerRecoveryRef.current = markerRecovery;
    markerRecovery.start();
    recovery.start();

    const dispose = () => {
      disposed = true;
      controller.abort();
      if (annotationRecoveryRef.current === recovery) annotationRecoveryRef.current = null;
      if (markerRecoveryRef.current === markerRecovery) markerRecoveryRef.current = null;
      recovery.dispose();
      markerRecovery.dispose();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [bookId, context, ownerKey]);

  useEffect(() => {
    if (!context) {
      const resetHealth = window.setTimeout(() => setPaletteHealth('healthy'), 0);
      return () => window.clearTimeout(resetHealth);
    }
    const owner = ownerRuntime.capture();
    if (!owner || owner.ownerKey !== ownerKey) return;
    const { authOwnerKey } = splitOwnerKey(owner.ownerKey);
    if (!authOwnerKey.startsWith('firebase:')) return;
    const uid = authOwnerKey.slice('firebase:'.length);
    const syncOwnerKey = getSyncOwnerKey(owner.ownerKey);
    const palettePath = getFirebaseAnnotationPalettePath(APP_ID, uid);
    const paletteDocumentRef = doc(db, palettePath);
    let disposed = false;
    const isCurrent = () => !disposed && ownerRuntime.isCurrent(owner);
    let authoritativeSeen = false;

    const handleSnapshot = async (snapshot: FirestoreDocumentSnapshot) => {
      if (!isCurrent() || snapshot.metadata.fromCache) return;
      const firstAuthoritativeSnapshot = !authoritativeSeen;
      authoritativeSeen = true;
      if (!snapshot.exists()) {
        if (firstAuthoritativeSnapshot) {
          if (isCurrent()) {
            await enqueueMissingLocalAnnotationPaletteV5(
              syncOwnerKey,
              paletteRef.current,
              context,
            );
          }
        }
        return;
      }
      let head;
      try {
        head = parseAnnotationPaletteHeadV1(snapshot.data());
      } catch (error) {
        throw toAnnotationSyncSchemaError(error);
      }
      await storeRemoteHeadsBatchV5(syncOwnerKey, [head]);
      if (!isCurrent()) return;
      if (isExactSyncSessionEcho(head.acceptedSessionId, context.sessionId)) return;
      const localPaletteBeforeCheck = JSON.stringify(paletteRef.current);
      if (await hasActiveSyncTargetWorkV5(
        syncOwnerKey,
        annotationPaletteTargetKeyV1(),
      )) return;
      if (
        !isCurrent()
        || JSON.stringify(paletteRef.current) !== localPaletteBeforeCheck
      ) return;
      await applyRemotePalette(head.palette.items);
    };

    const recovery = new SnapshotListenerRecovery<FirestoreDocumentSnapshot>({
      subscribe: (next, error) => {
        authoritativeSeen = false;
        return onSnapshot(
          paletteDocumentRef,
          { includeMetadataChanges: true },
          next,
          error,
        );
      },
      onSnapshot: handleSnapshot,
      isAuthoritative: (snapshot) => !snapshot.metadata.fromCache,
      onHealthChange: setPaletteHealth,
      onError: (error) => console.error('[AnnotationPaletteSync] listener failed:', error),
      canRetry: () => navigator.onLine,
    });
    paletteRecoveryRef.current = recovery;
    recovery.start();

    const dispose = () => {
      disposed = true;
      if (paletteRecoveryRef.current === recovery) paletteRecoveryRef.current = null;
      recovery.dispose();
    };
    const unregister = ownerRuntime.registerDisposer(dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [applyRemotePalette, context, ownerKey]);

  useEffect(() => {
    if (!context) return;
    const retry = () => {
      annotationRecoveryRef.current?.retryNow();
      markerRecoveryRef.current?.retryNow();
      paletteRecoveryRef.current?.retryNow();
    };
    const handleOnline = () => retry();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') retry();
    };
    const { authOwnerKey } = splitOwnerKey(ownerKey);
    const uid = authOwnerKey.startsWith('firebase:')
      ? authOwnerKey.slice('firebase:'.length)
      : '';
    const unsubscribeToken = onIdTokenChanged(auth, (user) => {
      if (user?.uid === uid) retry();
    });
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      unsubscribeToken();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [context, ownerKey]);

  return {
    annotationRevision,
    health: mergeSyncHealth(
      mergeSyncHealth(annotationHealth, markerHealth),
      paletteHealth,
    ),
  };
};
