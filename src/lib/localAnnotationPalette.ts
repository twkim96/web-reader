import type { AnnotationPaletteItem } from '../types';
import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
  V9_ANNOTATION_SETTINGS_STORE,
} from './localDBSchema';
import { normalizeAnnotationPalette } from './annotationPalette';
import {
  appendAnnotationPaletteEventToTransactionV5,
  type AnnotationSyncContextV5,
  type RemoteHeadCacheV5,
  type SyncConflictV5,
  type SyncOutboxEventV5,
  type SyncMetaV5,
} from './syncOutboxV5';
import { annotationPaletteTargetKeyV1, type AnnotationPaletteHeadV1 } from './annotationSyncSchema';
import { notifyProgressSyncWork } from './progressSyncWake';

export type StoredAnnotationPaletteV9 = {
  ownerKey: OwnerKey;
  palette: AnnotationPaletteItem[];
  updatedAt: number;
  syncRevision?: number;
  acceptedEventId?: string;
};

export const initializeLocalAnnotationPaletteV9 = async (
  ownerKey: OwnerKey,
  fallback: ReadonlyArray<AnnotationPaletteItem>,
) => {
  const db = await initDB();
  const tx = db.transaction(V9_ANNOTATION_SETTINGS_STORE, 'readwrite');
  const store = tx.objectStore(V9_ANNOTATION_SETTINGS_STORE);
  const existing = await store.get(ownerKey) as StoredAnnotationPaletteV9 | undefined;
  if (existing) {
    await tx.done;
    return normalizeAnnotationPalette(existing.palette);
  }
  const palette = normalizeAnnotationPalette(fallback);
  await store.put({ ownerKey, palette, updatedAt: Date.now() } satisfies StoredAnnotationPaletteV9);
  await tx.done;
  return palette;
};

export const getLocalAnnotationPaletteV9 = async (
  ownerKey: OwnerKey,
  fallback: ReadonlyArray<AnnotationPaletteItem>,
) => {
  const db = await initDB();
  const stored = await db.get(
    V9_ANNOTATION_SETTINGS_STORE,
    ownerKey,
  ) as StoredAnnotationPaletteV9 | undefined;
  return normalizeAnnotationPalette(stored?.palette ?? fallback);
};

export const saveLocalAnnotationPaletteV9 = async (
  ownerKey: OwnerKey,
  value: ReadonlyArray<AnnotationPaletteItem>,
  syncContext?: AnnotationSyncContextV5,
  now = Date.now(),
) => {
  const palette = normalizeAnnotationPalette(value);
  const db = await initDB();
  const stores = syncContext
    ? [
      V9_ANNOTATION_SETTINGS_STORE,
      V5_OUTBOX_STORE,
      V5_SYNC_META_STORE,
      V5_SYNC_CONFLICTS_STORE,
    ]
    : [V9_ANNOTATION_SETTINGS_STORE];
  const tx = db.transaction(stores, 'readwrite');
  void tx.done.catch(() => undefined);
  const result = syncContext
    ? await appendAnnotationPaletteEventToTransactionV5(
      tx,
      ownerKey,
      { payload: { items: palette }, occurredAtClient: now },
      syncContext,
    )
    : null;
  await tx.objectStore(V9_ANNOTATION_SETTINGS_STORE).put({
    ownerKey,
    palette,
    updatedAt: now,
  } satisfies StoredAnnotationPaletteV9);
  await tx.done;
  if (result && !result.deferredByConflict) notifyProgressSyncWork(ownerKey);
  return palette;
};

export type AdoptRemoteAnnotationPaletteResultV9 =
  | { status: 'applied'; palette: AnnotationPaletteItem[] }
  | { status: 'blocked-by-local-work' | 'stale-remote' | 'cancelled' };

// Serialize the decision with local palette + outbox writes from every tab.
export const adoptRemoteAnnotationPaletteV9 = async (
  ownerKey: OwnerKey,
  head: AnnotationPaletteHeadV1,
  isCurrent: () => boolean = () => true,
  now = Date.now(),
): Promise<AdoptRemoteAnnotationPaletteResultV9> => {
  const db = await initDB();
  if (!isCurrent()) return { status: 'cancelled' };
  const targetKey = annotationPaletteTargetKeyV1();
  const tx = db.transaction([
    V9_ANNOTATION_SETTINGS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const paletteStore = tx.objectStore(V9_ANNOTATION_SETTINGS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflicts = tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-target-state');
  const [stored, events, open, deferred, remote, meta] = await Promise.all([
    paletteStore.get(ownerKey) as Promise<StoredAnnotationPaletteV9 | undefined>,
    tx.objectStore(V5_OUTBOX_STORE).index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
      [ownerKey, targetKey, 0], [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
    )) as Promise<SyncOutboxEventV5[]>,
    conflicts.getAll([ownerKey, targetKey, 'open']) as Promise<SyncConflictV5[]>,
    conflicts.getAll([ownerKey, targetKey, 'deferred']) as Promise<SyncConflictV5[]>,
    tx.objectStore(V5_REMOTE_HEADS_STORE).get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
  ]);
  let skipped: Exclude<AdoptRemoteAnnotationPaletteResultV9, { status: 'applied' }> | undefined;
  if (!isCurrent()) {
    skipped = { status: 'cancelled' };
  } else if (events.some(({ status }) => (
    status === 'pending' || status === 'in_flight' || status === 'blocked'
    || status === 'conflict' || status === 'paused'
  )) || open.length > 0 || deferred.length > 0) {
    skipped = { status: 'blocked-by-local-work' };
  } else if (!remote || !('palette' in remote.head)
    || remote.revision !== head.revision
    || remote.head.acceptedEventId !== head.acceptedEventId
    || (meta?.knownRevision ?? 0) > head.revision
    || (stored?.syncRevision ?? 0) > head.revision
    || (stored?.syncRevision === head.revision
      && stored.acceptedEventId !== head.acceptedEventId)) {
    skipped = { status: 'stale-remote' };
  }
  if (skipped) {
    await tx.done;
    return skipped;
  }
  const palette = normalizeAnnotationPalette(head.palette.items);
  await paletteStore.put({
    ownerKey,
    palette,
    updatedAt: now,
    syncRevision: head.revision,
    acceptedEventId: head.acceptedEventId,
  } satisfies StoredAnnotationPaletteV9);
  await metaStore.put({
    ownerKey,
    targetKey,
    nextSequence: meta?.nextSequence ?? 1,
    knownRevision: head.revision,
    updatedAt: now,
  } satisfies SyncMetaV5);
  await tx.done;
  return { status: 'applied', palette };
};
