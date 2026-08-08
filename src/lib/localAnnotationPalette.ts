import type { AnnotationPaletteItem } from '../types';
import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
  V9_ANNOTATION_SETTINGS_STORE,
} from './localDBSchema';
import { normalizeAnnotationPalette } from './annotationPalette';
import {
  appendAnnotationPaletteEventToTransactionV5,
  type AnnotationSyncContextV5,
} from './syncOutboxV5';
import { notifyProgressSyncWork } from './progressSyncWake';

export type StoredAnnotationPaletteV9 = {
  ownerKey: OwnerKey;
  palette: AnnotationPaletteItem[];
  updatedAt: number;
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
