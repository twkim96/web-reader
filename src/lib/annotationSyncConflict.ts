import type { Annotation, AnnotationPaletteItem } from '../types';
import type { IDBPObjectStore } from 'idb';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
  V8_ANNOTATIONS_STORE,
  V9_ANNOTATION_SETTINGS_STORE,
} from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';
import {
  fromAnnotationSyncPayloadV1,
  isAnnotationHeadV1,
  isAnnotationPaletteHeadV1,
  isAnnotationPalettePayloadV1,
  isAnnotationSyncPayloadV1,
  type AnnotationSyncPayloadV1,
} from './annotationSyncSchema';
import { validateHydratedAnnotations } from './annotationSyncLocal';
import { isAnnotation } from './annotationPolicy';
import {
  DEFAULT_ANNOTATION_PALETTE,
  saveStoredAnnotationPalette,
} from './annotationPalette';
import {
  getOpenSyncConflictsV5,
  type AnnotationOutboxEventV5,
  type AnnotationPaletteOutboxEventV5,
  type RemoteHeadCacheV5,
  type SyncConflictV5,
  type SyncMetaV5,
  type SyncOutboxEventV5,
} from './syncOutboxV5';
import { notifyProgressSyncWork } from './progressSyncWake';
import { notifyAnnotationSyncChange } from './annotationSyncWake';

type StoredAnnotation = Annotation & { ownerKey: OwnerKey };

const withoutOwner = ({ ownerKey, ...annotation }: StoredAnnotation) => {
  void ownerKey;
  return annotation;
};

const supersedeEvents = async (
  outbox: IDBPObjectStore<unknown, string[], typeof V5_OUTBOX_STORE, 'readwrite'>,
  conflict: SyncConflictV5,
) => {
  const eventIds = [conflict.event?.eventId, ...conflict.blockedEventIds]
    .filter((eventId): eventId is string => Boolean(eventId));
  for (const eventId of eventIds) {
    const event = await outbox.get([conflict.ownerKey, eventId]) as SyncOutboxEventV5 | undefined;
    if (!event) continue;
    await outbox.put({
      ...event,
      status: 'superseded',
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    });
  }
};

const defaultMeta = (
  ownerKey: OwnerKey,
  targetKey: string,
  now: number,
): SyncMetaV5 => ({
  ownerKey,
  targetKey,
  knownRevision: 0,
  nextSequence: 1,
  updatedAt: now,
});

export const getOpenAnnotationSyncConflictsV5 = async (ownerKey: OwnerKey) => (
  (await getOpenSyncConflictsV5(ownerKey)).filter((conflict) => (
    conflict.event?.target.kind === 'annotation'
    || conflict.event?.target.kind === 'palette'
  ))
);

export const resolveAnnotationSyncConflictUseRemoteV5 = async (
  ownerKey: OwnerKey,
  conflictId: string,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_SYNC_META_STORE,
    V5_REMOTE_HEADS_STORE,
    V9_ANNOTATION_SETTINGS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  try {
    const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
    const conflict = await conflictStore.get([ownerKey, conflictId]) as
      SyncConflictV5 | undefined;
    if (
      !conflict?.event
      || (conflict.event.target.kind !== 'annotation'
        && conflict.event.target.kind !== 'palette')
    ) throw new Error('적용할 annotation 원격 충돌 데이터가 없습니다.');

    const metaStore = tx.objectStore(V5_SYNC_META_STORE);
    const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
    const meta = await metaStore.get([ownerKey, conflict.targetKey]) as SyncMetaV5 | undefined;
    let result:
      | { kind: 'annotation'; bookId: string }
      | { kind: 'palette'; palette: AnnotationPaletteItem[] };

    const remoteHead = conflict.remoteHead;
    if (conflict.event.target.kind === 'annotation') {
      if (remoteHead && (
        !isAnnotationHeadV1(remoteHead)
        || remoteHead.bookId !== conflict.event.target.bookId
        || remoteHead.annotationId !== conflict.event.target.annotationId
      )) throw new Error('원격 annotation 충돌 head가 올바르지 않습니다.');
      const annotationStore = tx.objectStore(V8_ANNOTATIONS_STORE);
      const stored = await annotationStore.index('by-owner-book').getAll([
        ownerKey,
        conflict.event.target.bookId,
      ]) as StoredAnnotation[];
      const current = new Map(stored.filter(isAnnotation).map((item) => (
        [item.id, withoutOwner(item)]
      )));
      const annotation = remoteHead?.operation === 'upsert'
        ? fromAnnotationSyncPayloadV1(remoteHead.annotation!)
        : null;
      if (annotation) current.set(annotation.id, annotation);
      else current.delete(conflict.event.target.annotationId);
      validateHydratedAnnotations([...current.values()]);
      if (annotation) await annotationStore.put({ ...annotation, ownerKey });
      else await annotationStore.delete([
        ownerKey,
        conflict.event.target.bookId,
        conflict.event.target.annotationId,
      ]);
      result = { kind: 'annotation', bookId: conflict.event.target.bookId };
    } else {
      if (remoteHead && !isAnnotationPaletteHeadV1(remoteHead)) {
        throw new Error('원격 annotation palette 충돌 head가 올바르지 않습니다.');
      }
      result = {
        kind: 'palette',
        palette: remoteHead?.palette.items
          ?? DEFAULT_ANNOTATION_PALETTE.map((item) => ({ ...item })),
      };
    }

    await supersedeEvents(tx.objectStore(V5_OUTBOX_STORE), conflict);
    const knownRevision = remoteHead
      ? Math.max(meta?.knownRevision ?? 0, remoteHead.revision)
      : 0;
    await Promise.all([
      metaStore.put({
        ...(meta ?? defaultMeta(ownerKey, conflict.targetKey, now)),
        knownRevision,
        updatedAt: now,
      }),
      remoteHead
        ? remoteStore.put({
          ownerKey,
          targetKey: conflict.targetKey,
          revision: remoteHead.revision,
          head: remoteHead,
          updatedAt: now,
        } satisfies RemoteHeadCacheV5)
        : remoteStore.delete([ownerKey, conflict.targetKey]),
      conflictStore.put({ ...conflict, state: 'resolved_remote', resolvedAt: now }),
      result.kind === 'palette'
        ? tx.objectStore(V9_ANNOTATION_SETTINGS_STORE).put({
          ownerKey,
          palette: result.palette,
          updatedAt: now,
        })
        : Promise.resolve(),
    ]);
    await tx.done;
    if (result.kind === 'palette') {
      saveStoredAnnotationPalette(ownerKey, result.palette);
      notifyAnnotationSyncChange({ ownerKey, palette: result.palette });
    } else {
      notifyAnnotationSyncChange({ ownerKey, bookId: result.bookId });
    }
    notifyProgressSyncWork(ownerKey);
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
};

export const resolveAnnotationSyncConflictKeepLocalV5 = async (
  ownerKey: OwnerKey,
  conflictId: string,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  try {
    const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
    const conflict = await conflictStore.get([ownerKey, conflictId]) as
      SyncConflictV5 | undefined;
    if (
      !conflict?.event
      || (conflict.event.target.kind !== 'annotation'
        && conflict.event.target.kind !== 'palette')
    ) throw new Error('유지할 annotation 로컬 충돌 데이터가 없습니다.');

    const metaStore = tx.objectStore(V5_SYNC_META_STORE);
    const meta = await metaStore.get([ownerKey, conflict.targetKey]) as SyncMetaV5 | undefined;
    const nextMeta = meta ?? defaultMeta(ownerKey, conflict.targetKey, now);
    let replacement: AnnotationOutboxEventV5 | AnnotationPaletteOutboxEventV5;
    if (conflict.event.target.kind === 'annotation') {
      const event = conflict.event as AnnotationOutboxEventV5;
      const payload = conflict.latestLocalPosition;
      if (payload !== null && !isAnnotationSyncPayloadV1(payload)) {
        throw new Error('유지할 local annotation payload가 올바르지 않습니다.');
      }
      replacement = {
        ...event,
        eventId: crypto.randomUUID(),
        operation: payload === null ? 'annotation.delete' : 'annotation.upsert',
        payload: payload as AnnotationSyncPayloadV1 | null,
        sequence: nextMeta.nextSequence,
        baseRevision: conflict.remoteHead?.revision ?? 0,
        occurredAtClient: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lastErrorCode: null,
        claimedByTabId: null,
        claimedLeaseEpoch: null,
        claimToken: null,
      };
    } else {
      const event = conflict.event as AnnotationPaletteOutboxEventV5;
      if (!isAnnotationPalettePayloadV1(conflict.latestLocalPosition)) {
        throw new Error('유지할 local annotation palette가 올바르지 않습니다.');
      }
      replacement = {
        ...event,
        eventId: crypto.randomUUID(),
        operation: 'palette.set',
        payload: conflict.latestLocalPosition,
        sequence: nextMeta.nextSequence,
        baseRevision: conflict.remoteHead?.revision ?? 0,
        occurredAtClient: now,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lastErrorCode: null,
        claimedByTabId: null,
        claimedLeaseEpoch: null,
        claimToken: null,
      };
    }
    const outbox = tx.objectStore(V5_OUTBOX_STORE);
    await supersedeEvents(outbox, conflict);
    await Promise.all([
      outbox.add(replacement),
      metaStore.put({
        ...nextMeta,
        nextSequence: nextMeta.nextSequence + 1,
        updatedAt: now,
      }),
      conflictStore.put({ ...conflict, state: 'resolved_local', resolvedAt: now }),
    ]);
    await tx.done;
    notifyProgressSyncWork(ownerKey);
    return replacement;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // A failed request may already have aborted the transaction.
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
};
