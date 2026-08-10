import type { Annotation, HighlightColorId } from '../types';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_META_STORE,
  V8_ANNOTATIONS_STORE,
} from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';
import {
  ANNOTATION_BOOK_LIMIT,
  ANNOTATION_BOOK_DELETE_MARKER_ID,
  ANNOTATION_COLOR_LIMIT,
  isAnnotation,
} from './annotationPolicy';
import {
  annotationTargetKeyV1,
  annotationPaletteTargetKeyV1,
  fromAnnotationSyncPayloadV1,
  isAnnotationHeadV1,
  toAnnotationSyncPayloadV1,
  type AnnotationHeadV1,
  type AnnotationSyncPayloadV1,
} from './annotationSyncSchema';
import {
  appendAnnotationEventsToTransactionV5,
  enqueueAnnotationPaletteEventV5,
  hasActiveSyncTargetWorkV5,
  type AnnotationSyncContextV5,
  type RemoteHeadCacheV5,
  type SyncConflictV5,
  type SyncMetaV5,
  type SyncOutboxEventV5,
} from './syncOutboxV5';
import { notifyProgressSyncWork } from './progressSyncWake';

type StoredAnnotation = Annotation & { ownerKey: OwnerKey };

const activeStatuses = new Set([
  'pending', 'in_flight', 'blocked', 'conflict', 'paused',
]);

const withoutOwner = ({ ownerKey, ...annotation }: StoredAnnotation) => {
  void ownerKey;
  return annotation;
};

const samePayload = (annotation: Annotation, payload: AnnotationSyncPayloadV1) => {
  const current = toAnnotationSyncPayloadV1(annotation);
  return current.id === payload.id
    && current.bookId === payload.bookId
    && current.type === payload.type
    && current.sectionIndex === payload.sectionIndex
    && current.rangeCfi === payload.rangeCfi
    && current.quote === payload.quote
    && current.prefix === payload.prefix
    && current.suffix === payload.suffix
    && current.colorId === payload.colorId
    && current.note === payload.note
    && current.progressPercent === payload.progressPercent
    && current.chapter === payload.chapter
    && current.createdAtClient === payload.createdAtClient
    && current.updatedAtClient === payload.updatedAtClient;
};

export const validateHydratedAnnotations = (annotations: ReadonlyArray<Annotation>) => {
  if (annotations.length > ANNOTATION_BOOK_LIMIT) {
    throw new Error('원격 annotation이 책당 제한을 초과했습니다.');
  }
  const ranges = new Set<string>();
  const colors = new Map<HighlightColorId, number>();
  for (const annotation of annotations) {
    if (!isAnnotation(annotation)) throw new Error('원격 annotation schema가 올바르지 않습니다.');
    if (ranges.has(annotation.rangeCfi)) {
      throw new Error('원격 annotation에 중복 범위가 있습니다.');
    }
    ranges.add(annotation.rangeCfi);
    const count = (colors.get(annotation.colorId) ?? 0) + 1;
    if (count > ANNOTATION_COLOR_LIMIT) {
      throw new Error('원격 annotation이 색상별 제한을 초과했습니다.');
    }
    colors.set(annotation.colorId, count);
  }
};

export const getCachedRemoteAnnotationHeadsV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  const cached = await db.getAllFromIndex(
    V5_REMOTE_HEADS_STORE,
    'by-owner',
    ownerKey,
  ) as RemoteHeadCacheV5[];
  return cached
    .map(({ head }) => head)
    .filter((head): head is AnnotationHeadV1 => (
      isAnnotationHeadV1(head) && head.bookId === bookId
    ));
};

export const getLocalAnnotationIdsV8 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => {
  const db = await initDB();
  const records = await db.getAllFromIndex(
    V8_ANNOTATIONS_STORE,
    'by-owner-book',
    [ownerKey, bookId],
  ) as StoredAnnotation[];
  return records.filter(isAnnotation).map(({ id }) => id);
};

const applyRemoteAnnotationBookDeletionMarkerTransactionV5 = async (
  ownerKey: OwnerKey,
  incomingMarkerHead: AnnotationHeadV1,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
  now = Date.now(),
) => {
  const bookId = incomingMarkerHead.bookId;
  if (
    incomingMarkerHead.annotationId !== ANNOTATION_BOOK_DELETE_MARKER_ID
    || incomingMarkerHead.operation !== 'delete'
  ) throw new TypeError('annotation 삭제 marker가 올바르지 않습니다.');
  if (!isCurrent()) return { changed: false, removed: 0, skipped: 0, stale: true };
  const db = await initDB();
  const tx = db.transaction([
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const abortTransaction = () => {
    try {
      tx.abort();
    } catch {
      // The transaction may already be committed or aborted.
    }
  };
  signal?.addEventListener('abort', abortTransaction, { once: true });
  try {
    if (signal?.aborted) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, removed: 0, skipped: 0, stale: true };
    }
    const annotationStore = tx.objectStore(V8_ANNOTATIONS_STORE);
    const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
    const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
    const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
    const metaStore = tx.objectStore(V5_SYNC_META_STORE);
    const markerTargetKey = annotationTargetKeyV1(
      bookId,
      ANNOTATION_BOOK_DELETE_MARKER_ID,
    );
    const [stored, markerCache, markerMeta] = await Promise.all([
      annotationStore.index('by-owner-book').getAll([
        ownerKey,
        bookId,
      ]) as Promise<StoredAnnotation[]>,
      remoteStore.get([ownerKey, markerTargetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
      metaStore.get([ownerKey, markerTargetKey]) as Promise<SyncMetaV5 | undefined>,
    ]);
    let effectiveMarkerHead = markerCache?.head;
    const isSameHead = markerCache?.revision === incomingMarkerHead.revision
      && markerCache.head.acceptedEventId === incomingMarkerHead.acceptedEventId;
    if (
      !isSameHead
      && (!markerCache || incomingMarkerHead.revision >= markerCache.revision)
    ) {
      await remoteStore.put({
        ownerKey,
        targetKey: markerTargetKey,
        revision: incomingMarkerHead.revision,
        head: incomingMarkerHead,
        updatedAt: now,
      } satisfies RemoteHeadCacheV5);
      effectiveMarkerHead = incomingMarkerHead;
    }
    const knownRevision = Math.max(
      markerMeta?.knownRevision ?? 0,
      markerCache?.revision ?? 0,
      incomingMarkerHead.revision,
    );
    if (!markerMeta || knownRevision > markerMeta.knownRevision) {
      await metaStore.put({
        ...(markerMeta ?? {
          ownerKey,
          targetKey: markerTargetKey,
          knownRevision: 0,
          nextSequence: 1,
          updatedAt: now,
        }),
        knownRevision,
        updatedAt: now,
      } satisfies SyncMetaV5);
    }
    if (
      !effectiveMarkerHead
      || !isAnnotationHeadV1(effectiveMarkerHead)
      || effectiveMarkerHead.bookId !== bookId
      || effectiveMarkerHead.annotationId !== ANNOTATION_BOOK_DELETE_MARKER_ID
      || effectiveMarkerHead.operation !== 'delete'
    ) {
      await tx.done;
      return { changed: false, removed: 0, skipped: 0, stale: false };
    }

    const current = new Map(stored.filter(isAnnotation).map((item) => (
      [item.id, withoutOwner(item)]
    )));
    let removed = 0;
    let skipped = 0;
    for (const annotation of current.values()) {
      const targetKey = annotationTargetKeyV1(bookId, annotation.id);
      const [cached, targetEvents, openConflicts, deferredConflicts] = await Promise.all([
        remoteStore.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
        outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
          [ownerKey, targetKey, 0],
          [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
        )) as Promise<SyncOutboxEventV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'open',
        ]) as Promise<SyncConflictV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'deferred',
        ]) as Promise<SyncConflictV5[]>,
      ]);
      const head = cached?.head;
      if (
        !head
        || !isAnnotationHeadV1(head)
        || head.bookId !== bookId
        || head.annotationId !== annotation.id
        || head.operation !== 'upsert'
        || (head.bookGeneration ?? 0) >= effectiveMarkerHead.revision
      ) continue;
      const hasLocalWork = targetEvents.some((event) => activeStatuses.has(event.status))
        || openConflicts.length > 0
        || deferredConflicts.length > 0;
      if (hasLocalWork) {
        skipped += 1;
        continue;
      }
      await annotationStore.delete([ownerKey, bookId, annotation.id]);
      current.delete(annotation.id);
      removed += 1;
    }
    validateHydratedAnnotations([...current.values()]);
    if (!isCurrent() || signal?.aborted) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, removed: 0, skipped: 0, stale: true };
    }
    await tx.done;
    return { changed: removed > 0, removed, skipped, stale: false };
  } catch (error) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    if (signal?.aborted || !isCurrent()) {
      return { changed: false, removed: 0, skipped: 0, stale: true };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortTransaction);
  }
};

export const applyRemoteAnnotationBookDeletionMarkerV5 = (
  ownerKey: OwnerKey,
  markerHead: AnnotationHeadV1,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
  now = Date.now(),
) => applyRemoteAnnotationBookDeletionMarkerTransactionV5(
  ownerKey,
  markerHead,
  isCurrent,
  signal,
  now,
);

export const enqueueMissingLocalAnnotationPaletteV5 = async (
  ownerKey: OwnerKey,
  items: Parameters<typeof enqueueAnnotationPaletteEventV5>[1]['payload']['items'],
  context: AnnotationSyncContextV5,
) => {
  if (await hasActiveSyncTargetWorkV5(ownerKey, annotationPaletteTargetKeyV1())) {
    return null;
  }
  return enqueueAnnotationPaletteEventV5(ownerKey, { payload: { items } }, context);
};

export const hydrateRemoteAnnotationHeadsV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  heads: ReadonlyArray<AnnotationHeadV1>,
  currentSessionId: string,
  now = Date.now(),
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) => {
  if (heads.some((head) => head.bookId !== bookId)) {
    throw new Error('원격 annotation book 경계가 올바르지 않습니다.');
  }
  if (!isCurrent()) return { changed: false, applied: 0, skipped: 0, stale: true };
  const db = await initDB();
  const tx = db.transaction([
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const abortTransaction = () => {
    try {
      tx.abort();
    } catch {
      // The transaction may already be committed or aborted.
    }
  };
  signal?.addEventListener('abort', abortTransaction, { once: true });
  try {
    const annotationStore = tx.objectStore(V8_ANNOTATIONS_STORE);
    const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
    const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
    const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
    const metaStore = tx.objectStore(V5_SYNC_META_STORE);
    const stored = await annotationStore.index('by-owner-book').getAll([
      ownerKey,
      bookId,
    ]) as StoredAnnotation[];
    const markerTargetKey = annotationTargetKeyV1(
      bookId,
      ANNOTATION_BOOK_DELETE_MARKER_ID,
    );
    const markerCache = await remoteStore.get([
      ownerKey,
      markerTargetKey,
    ]) as RemoteHeadCacheV5 | undefined;
    const markerHead = markerCache?.head;
    const currentBookGeneration = markerHead
      && isAnnotationHeadV1(markerHead)
      && markerHead.bookId === bookId
      && markerHead.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID
      && markerHead.operation === 'delete'
      ? markerHead.revision
      : 0;
    if (!isCurrent()) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, applied: 0, skipped: 0, stale: true };
    }
    const current = new Map(stored.filter(isAnnotation).map((item) => (
      [item.id, withoutOwner(item)]
    )));
    const writes: Array<{ type: 'put'; annotation: Annotation } | { type: 'delete'; id: string }> = [];
    const remoteWrites: Array<{
      head: AnnotationHeadV1;
      targetKey: string;
      meta?: SyncMetaV5;
    }> = [];
    let skipped = 0;

    for (const head of heads) {
      const targetKey = annotationTargetKeyV1(bookId, head.annotationId);
      const [targetEvents, openConflicts, deferredConflicts, meta] = await Promise.all([
        outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
          [ownerKey, targetKey, 0],
          [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
        )) as Promise<SyncOutboxEventV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'open',
        ]) as Promise<SyncConflictV5[]>,
        conflictStore.index('by-owner-target-state').getAll([
          ownerKey,
          targetKey,
          'deferred',
        ]) as Promise<SyncConflictV5[]>,
        metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
      ]);
      remoteWrites.push({ head, targetKey, meta });
      const hasLocalWork = targetEvents.some((event) => activeStatuses.has(event.status))
        || openConflicts.length > 0
        || deferredConflicts.length > 0;
      if (hasLocalWork) {
        skipped += 1;
        continue;
      }
      const existing = current.get(head.annotationId);
      if (head.operation === 'delete') {
        if (existing) {
          current.delete(head.annotationId);
          writes.push({ type: 'delete', id: head.annotationId });
        }
        continue;
      }
      if ((head.bookGeneration ?? 0) < currentBookGeneration) {
        if (existing) {
          current.delete(head.annotationId);
          writes.push({ type: 'delete', id: head.annotationId });
        }
        continue;
      }
      const payload = head.annotation!;
      if (head.acceptedSessionId === currentSessionId && existing) continue;
      if (existing && samePayload(existing, payload)) continue;
      const annotation = fromAnnotationSyncPayloadV1(payload);
      current.set(annotation.id, annotation);
      writes.push({ type: 'put', annotation });
    }

    validateHydratedAnnotations([...current.values()]);
    if (!isCurrent()) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, applied: 0, skipped: 0, stale: true };
    }
    for (const write of writes) {
      if (write.type === 'delete') {
        await annotationStore.delete([ownerKey, bookId, write.id]);
      } else {
        await annotationStore.put({ ...write.annotation, ownerKey });
      }
    }
    for (const { head, targetKey, meta } of remoteWrites) {
      const existingRemote = await remoteStore.get([
        ownerKey,
        targetKey,
      ]) as RemoteHeadCacheV5 | undefined;
      if (!existingRemote || head.revision >= existingRemote.revision) {
        await remoteStore.put({
          ownerKey,
          targetKey,
          revision: head.revision,
          head,
          updatedAt: now,
        } satisfies RemoteHeadCacheV5);
      }
      await metaStore.put({
        ownerKey,
        targetKey,
        knownRevision: Math.max(
          meta?.knownRevision ?? 0,
          existingRemote?.revision ?? 0,
          head.revision,
        ),
        nextSequence: meta?.nextSequence ?? 1,
        updatedAt: now,
      } satisfies SyncMetaV5);
    }
    if (!isCurrent() || signal?.aborted) {
      abortTransaction();
      await tx.done.catch(() => undefined);
      return { changed: false, applied: 0, skipped: 0, stale: true };
    }
    await tx.done;
    return { changed: writes.length > 0, applied: writes.length, skipped };
  } catch (error) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    if (signal?.aborted) {
      return { changed: false, applied: 0, skipped: 0, stale: true };
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortTransaction);
  }
};

export const enqueueMissingLocalAnnotationsV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  remoteAnnotationIds: ReadonlySet<string>,
  context: AnnotationSyncContextV5,
  isCurrent: () => boolean = () => true,
  signal?: AbortSignal,
) => {
  if (!isCurrent()) return [];
  const db = await initDB();
  const tx = db.transaction([
    V8_ANNOTATIONS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_REMOTE_HEADS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const abortTransaction = () => {
    try {
      tx.abort();
    } catch {
      // The transaction may already be committed or aborted.
    }
  };
  signal?.addEventListener('abort', abortTransaction, { once: true });
  try {
  const records = await tx.objectStore(V8_ANNOTATIONS_STORE)
    .index('by-owner-book')
    .getAll([ownerKey, bookId]) as StoredAnnotation[];
  if (!isCurrent()) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    return [];
  }
  const localOnly = records
    .filter(isAnnotation)
    .map(withoutOwner)
    .filter(({ id }) => !remoteAnnotationIds.has(id));
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const uploadable: Annotation[] = [];
  for (const annotation of localOnly) {
    const targetKey = annotationTargetKeyV1(bookId, annotation.id);
    const [targetEvents, openConflicts, deferredConflicts] = await Promise.all([
      outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<SyncOutboxEventV5[]>,
      conflictStore.index('by-owner-target-state').getAll([
        ownerKey,
        targetKey,
        'open',
      ]) as Promise<SyncConflictV5[]>,
      conflictStore.index('by-owner-target-state').getAll([
        ownerKey,
        targetKey,
        'deferred',
      ]) as Promise<SyncConflictV5[]>,
    ]);
    if (
      targetEvents.some((event) => activeStatuses.has(event.status))
      || openConflicts.length > 0
      || deferredConflicts.length > 0
    ) continue;
    uploadable.push(annotation);
  }
  const events = await appendAnnotationEventsToTransactionV5(
    tx,
    ownerKey,
    uploadable.map((annotation) => ({
      bookId,
      annotationId: annotation.id,
      operation: 'annotation.upsert' as const,
      payload: toAnnotationSyncPayloadV1(annotation),
      occurredAtClient: annotation.updatedAtClient,
    })),
    context,
  );
  if (!isCurrent()) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    return [];
  }
  await tx.done;
  if (events.length > 0) notifyProgressSyncWork(ownerKey);
  return events;
  } catch (error) {
    abortTransaction();
    await tx.done.catch(() => undefined);
    if (signal?.aborted) return [];
    throw error;
  } finally {
    signal?.removeEventListener('abort', abortTransaction);
  }
};
