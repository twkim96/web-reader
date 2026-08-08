import type { IDBPDatabase, IDBPObjectStore, IDBPTransaction } from 'idb';
import type { Bookmark, UserProgress } from '../types';
import { initDB } from './localDB';
import {
  V5_OUTBOX_STORE,
  V5_PROGRESS_STORE,
  V5_REMOTE_HEADS_STORE,
  V5_SYNC_CONFLICTS_STORE,
  V5_SYNC_LEASES_STORE,
  V5_SYNC_META_STORE,
} from './localDBSchema';
import type { OwnerKey } from './ownerIdentity';
import {
  notifyProgressSyncWork,
  notifyProgressSyncWorkAfter,
} from './progressSyncWake';
import {
  bookmarkTargetKeyV2,
  isManualBookmarkPayloadV2,
  isProgressPositionV2,
  progressTargetKeyV2,
  type BookmarkHeadV2,
  type ManualBookmarkPayloadV2,
  type ProgressHeadV2,
  type ProgressPositionV2,
} from './progressV2Schema';
import {
  annotationPaletteTargetKeyV1,
  annotationTargetKeyV1,
  isAnnotationPalettePayloadV1,
  isAnnotationSyncPayloadV1,
  type AnnotationHeadV1,
  type AnnotationAggregateConflictReasonV1,
  type AnnotationPaletteHeadV1,
  type AnnotationPalettePayloadV1,
  type AnnotationSyncPayloadV1,
} from './annotationSyncSchema';

export type OutboxStatusV5 =
  | 'pending'
  | 'in_flight'
  | 'blocked'
  | 'conflict'
  | 'paused'
  | 'superseded';

export type ProgressOutboxEventV5 = {
  ownerKey: OwnerKey;
  eventId: string;
  target: { kind: 'progress'; bookId: string };
  targetKey: string;
  operation: 'progress.set' | 'progress.reset';
  payload: ProgressPositionV2 | null;
  deviceId: string;
  sessionId: string;
  sequence: number;
  baseRevision: number;
  occurredAtClient: number;
  status: OutboxStatusV5;
  attempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  claimedByTabId: string | null;
  claimedLeaseEpoch: number | null;
  claimToken: string | null;
};

export type BookmarkOutboxEventV5 = {
  ownerKey: OwnerKey;
  eventId: string;
  target: { kind: 'bookmark'; bookId: string; bookmarkId: string };
  targetKey: string;
  operation: 'bookmark.upsert' | 'bookmark.delete';
  payload: ManualBookmarkPayloadV2 | null;
  deviceId: string;
  sessionId: string;
  sequence: number;
  baseRevision: number;
  occurredAtClient: number;
  status: OutboxStatusV5;
  attempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  claimedByTabId: string | null;
  claimedLeaseEpoch: number | null;
  claimToken: string | null;
};

export type AnnotationOutboxEventV5 = {
  ownerKey: OwnerKey;
  eventId: string;
  target: { kind: 'annotation'; bookId: string; annotationId: string };
  targetKey: string;
  operation: 'annotation.upsert' | 'annotation.delete';
  payload: AnnotationSyncPayloadV1 | null;
  deviceId: string;
  sessionId: string;
  sequence: number;
  baseRevision: number;
  forceDelete?: boolean;
  occurredAtClient: number;
  status: OutboxStatusV5;
  attempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  claimedByTabId: string | null;
  claimedLeaseEpoch: number | null;
  claimToken: string | null;
};

export type AnnotationPaletteOutboxEventV5 = {
  ownerKey: OwnerKey;
  eventId: string;
  target: { kind: 'palette' };
  targetKey: string;
  operation: 'palette.set';
  payload: AnnotationPalettePayloadV1;
  deviceId: string;
  sessionId: string;
  sequence: number;
  baseRevision: number;
  occurredAtClient: number;
  status: OutboxStatusV5;
  attempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  claimedByTabId: string | null;
  claimedLeaseEpoch: number | null;
  claimToken: string | null;
};

export type SyncOutboxEventV5 =
  | ProgressOutboxEventV5
  | BookmarkOutboxEventV5
  | AnnotationOutboxEventV5
  | AnnotationPaletteOutboxEventV5;
export type SyncHeadV2 =
  | ProgressHeadV2
  | BookmarkHeadV2
  | AnnotationHeadV1
  | AnnotationPaletteHeadV1;

const activeStatuses = new Set<OutboxStatusV5>([
  'pending', 'in_flight', 'blocked', 'conflict', 'paused',
]);

export type ExpectedClaimV5 = {
  tabId: string;
  leaseEpoch: number;
  claimToken: string;
};

export const getExpectedClaimV5 = (
  event: SyncOutboxEventV5,
): ExpectedClaimV5 | null => (
  event.status === 'in_flight'
  && event.claimedByTabId
  && event.claimedLeaseEpoch !== null
  && event.claimToken
    ? {
      tabId: event.claimedByTabId,
      leaseEpoch: event.claimedLeaseEpoch,
      claimToken: event.claimToken,
    }
    : null
);

const ownsExpectedClaim = (
  event: SyncOutboxEventV5,
  expected: ExpectedClaimV5,
) => (
  event.status === 'in_flight'
  && event.claimedByTabId === expected.tabId
  && event.claimedLeaseEpoch === expected.leaseEpoch
  && event.claimToken === expected.claimToken
);

export const isProgressOutboxEventV5 = (
  event: SyncOutboxEventV5,
): event is ProgressOutboxEventV5 => event.target.kind === 'progress';

export const isBookmarkOutboxEventV5 = (
  event: SyncOutboxEventV5,
): event is BookmarkOutboxEventV5 => event.target.kind === 'bookmark';

export const isAnnotationOutboxEventV5 = (
  event: SyncOutboxEventV5,
): event is AnnotationOutboxEventV5 => event.target.kind === 'annotation';

export const isAnnotationPaletteOutboxEventV5 = (
  event: SyncOutboxEventV5,
): event is AnnotationPaletteOutboxEventV5 => event.target.kind === 'palette';

export type SyncMetaV5 = {
  ownerKey: OwnerKey;
  targetKey: string;
  knownRevision: number;
  nextSequence: number;
  updatedAt: number;
};

export type RemoteHeadCacheV5 = {
  ownerKey: OwnerKey;
  targetKey: string;
  revision: number;
  head: SyncHeadV2;
  updatedAt: number;
};

export type SyncConflictV5 = {
  ownerKey: OwnerKey;
  conflictId: string;
  targetKey: string;
  state: 'open' | 'resolved_local' | 'resolved_remote' | 'deferred' | 'remote_missing';
  event: SyncOutboxEventV5 | null;
  remoteHead: SyncHeadV2 | null;
  conflictReason?: AnnotationAggregateConflictReasonV1;
  latestLocalPosition:
    | ProgressPositionV2
    | ManualBookmarkPayloadV2
    | AnnotationSyncPayloadV1
    | AnnotationPalettePayloadV1
    | null;
  blockedEventIds: string[];
  createdAt: number;
  resolvedAt?: number;
};

export const storeRemoteHeadsBatchV5 = async (
  ownerKey: OwnerKey,
  heads: SyncHeadV2[],
  now = Date.now(),
) => {
  if (heads.length === 0) return;
  const db = await initDB();
  const tx = db.transaction([V5_REMOTE_HEADS_STORE, V5_SYNC_META_STORE], 'readwrite');
  const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const entries = heads.map((head) => {
    const targetKey = 'position' in head
      ? progressTargetKeyV2(head.bookId)
      : 'bookmarkId' in head
        ? bookmarkTargetKeyV2(head.bookId, head.bookmarkId)
        : 'annotationId' in head
          ? annotationTargetKeyV1(head.bookId, head.annotationId)
          : annotationPaletteTargetKeyV1();
    return { head, targetKey };
  });
  const existingEntries = await Promise.all(entries.map(async ({ targetKey }) => Promise.all([
    remoteStore.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
  ])));
  for (const [index, { head, targetKey }] of entries.entries()) {
    const [existingRemote, existingMeta] = existingEntries[index];
    const isSameHead = existingRemote?.revision === head.revision
      && existingRemote.head.acceptedEventId === head.acceptedEventId;
    if (!isSameHead && (!existingRemote || head.revision >= existingRemote.revision)) {
      await remoteStore.put({
        ownerKey,
        targetKey,
        revision: head.revision,
        head,
        updatedAt: now,
      } satisfies RemoteHeadCacheV5);
    }
    const knownRevision = Math.max(
      existingMeta?.knownRevision ?? 0,
      existingRemote?.revision ?? 0,
      head.revision,
    );
    if (!existingMeta || knownRevision > existingMeta.knownRevision) {
      await metaStore.put({
        ...(existingMeta ?? defaultSyncMeta(ownerKey, targetKey, now)),
        knownRevision,
        updatedAt: now,
      });
    }
  }
  await tx.done;
};

export const storeRemoteProgressHeadV5 = async (
  ownerKey: OwnerKey,
  head: ProgressHeadV2,
  now = Date.now(),
) => storeRemoteHeadsBatchV5(ownerKey, [head], now);

export const storeRemoteBookmarkHeadV5 = async (
  ownerKey: OwnerKey,
  head: BookmarkHeadV2,
  now = Date.now(),
) => storeRemoteHeadsBatchV5(ownerKey, [head], now);

export const adoptRemoteProgressLocallyV5 = async (
  ownerKey: OwnerKey,
  progress: UserProgress,
  now = Date.now(),
) => {
  if (!progress.syncRevision || !progress.acceptedEventId) return false;
  const targetKey = progressTargetKeyV2(progress.bookId);
  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  const [targetEvents, openConflicts, deferredConflicts] = await Promise.all([
    tx.objectStore(V5_OUTBOX_STORE)
      .index('by-owner-target-sequence')
      .getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<SyncOutboxEventV5[]>,
    tx.objectStore(V5_SYNC_CONFLICTS_STORE)
      .index('by-owner-target-state')
      .getAll([ownerKey, targetKey, 'open']) as Promise<SyncConflictV5[]>,
    tx.objectStore(V5_SYNC_CONFLICTS_STORE)
      .index('by-owner-target-state')
      .getAll([ownerKey, targetKey, 'deferred']) as Promise<SyncConflictV5[]>,
  ]);
  if (
    targetEvents.some((event) => activeStatuses.has(event.status))
    || openConflicts.length > 0
    || deferredConflicts.length > 0
  ) {
    tx.abort();
    await tx.done.catch(() => undefined);
    return false;
  }
  const remote = await tx.objectStore(V5_REMOTE_HEADS_STORE).get([
    ownerKey,
    targetKey,
  ]) as RemoteHeadCacheV5 | undefined;
  if (
    !remote
    || remote.revision !== progress.syncRevision
    || remote.head.acceptedEventId !== progress.acceptedEventId
    || 'bookmarkId' in remote.head
  ) {
    tx.abort();
    await tx.done.catch(() => undefined);
    return false;
  }
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const meta = await metaStore.get([ownerKey, targetKey]) as SyncMetaV5 | undefined;
  await Promise.all([
    tx.objectStore(V5_PROGRESS_STORE).put({ ...progress, ownerKey }),
    metaStore.put({
      ...(meta ?? defaultSyncMeta(ownerKey, targetKey, now)),
      knownRevision: Math.max(meta?.knownRevision ?? 0, progress.syncRevision),
      updatedAt: now,
    }),
  ]);
  await tx.done;
  return true;
};

export const hasActiveProgressTargetWorkV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
) => hasActiveSyncTargetWorkV5(ownerKey, progressTargetKeyV2(bookId));

export const hasActiveSyncTargetWorkV5 = async (
  ownerKey: OwnerKey,
  targetKey: string,
) => {
  const db = await initDB();
  const tx = db.transaction([V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE], 'readonly');
  const [targetEvents, openConflicts, deferredConflicts] = await Promise.all([
    tx.objectStore(V5_OUTBOX_STORE)
      .index('by-owner-target-sequence')
      .getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<SyncOutboxEventV5[]>,
    tx.objectStore(V5_SYNC_CONFLICTS_STORE)
      .index('by-owner-target-state')
      .getAll([ownerKey, targetKey, 'open']) as Promise<SyncConflictV5[]>,
    tx.objectStore(V5_SYNC_CONFLICTS_STORE)
      .index('by-owner-target-state')
      .getAll([ownerKey, targetKey, 'deferred']) as Promise<SyncConflictV5[]>,
  ]);
  await tx.done;
  return targetEvents.some((event) => activeStatuses.has(event.status))
    || openConflicts.length > 0
    || deferredConflicts.length > 0;
};

export const recordRemoteMissingV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  now = Date.now(),
) => {
  const targetKey = progressTargetKeyV2(bookId);
  const db = await initDB();
  const conflict: SyncConflictV5 = {
    ownerKey,
    conflictId: `remote-missing:${bookId}`,
    targetKey,
    state: 'remote_missing',
    event: null,
    remoteHead: null,
    latestLocalPosition: null,
    blockedEventIds: [],
    createdAt: now,
  };
  const tx = db.transaction([V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE], 'readwrite');
  await Promise.all([
    tx.objectStore(V5_SYNC_CONFLICTS_STORE).put(conflict),
    tx.objectStore(V5_REMOTE_HEADS_STORE).delete([ownerKey, targetKey]),
  ]);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return conflict;
};

export const recordRemoteBookmarkMissingV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  bookmarkId: string,
  now = Date.now(),
) => {
  const targetKey = bookmarkTargetKeyV2(bookId, bookmarkId);
  const db = await initDB();
  const conflict: SyncConflictV5 = {
    ownerKey,
    conflictId: `remote-missing:${bookId}:${bookmarkId}`,
    targetKey,
    state: 'remote_missing',
    event: null,
    remoteHead: null,
    latestLocalPosition: null,
    blockedEventIds: [],
    createdAt: now,
  };
  const tx = db.transaction([V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE], 'readwrite');
  await Promise.all([
    tx.objectStore(V5_SYNC_CONFLICTS_STORE).put(conflict),
    tx.objectStore(V5_REMOTE_HEADS_STORE).delete([ownerKey, targetKey]),
  ]);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return conflict;
};

export type SyncLeaseV5 = {
  ownerKey: OwnerKey;
  holderTabId: string;
  epoch: number;
  expiresAt: number;
  heartbeatAt: number;
};

export type EnqueueProgressInput = {
  bookId: string;
  operation: 'progress.set' | 'progress.reset';
  position: ProgressPositionV2 | null;
  deviceId: string;
  sessionId: string;
  occurredAtClient?: number;
  eventId?: string;
  localBookmarks?: Bookmark[];
};

export type EnqueueBookmarkInput = {
  bookId: string;
  bookmarkId: string;
  operation: 'bookmark.upsert' | 'bookmark.delete';
  payload: ManualBookmarkPayloadV2 | null;
  localBookmarks: Bookmark[];
  deviceId: string;
  sessionId: string;
  occurredAtClient?: number;
  eventId?: string;
};

export type EnqueueProgressMutationBatchInput = {
  progress: UserProgress;
  progressEvent: EnqueueProgressInput | null;
  bookmarkEvents: EnqueueBookmarkInput[];
};

export type AnnotationSyncContextV5 = {
  deviceId: string;
  sessionId: string;
  createEventId?: () => string;
};

export type EnqueueAnnotationInputV5 = {
  bookId: string;
  annotationId: string;
  operation: 'annotation.upsert' | 'annotation.delete';
  payload: AnnotationSyncPayloadV1 | null;
  occurredAtClient?: number;
  eventId?: string;
  baseRevision?: number;
  forceDelete?: boolean;
};

export type EnqueueAnnotationPaletteInputV5 = {
  payload: AnnotationPalettePayloadV1;
  occurredAtClient?: number;
  eventId?: string;
};

const eventSort = (a: SyncOutboxEventV5, b: SyncOutboxEventV5) => (
  a.sequence - b.sequence
);

const getTargetEvents = async (
  db: IDBPDatabase<unknown>,
  ownerKey: OwnerKey,
  targetKey: string,
) => {
  const events = await db.getAllFromIndex(
    V5_OUTBOX_STORE,
    'by-owner-target-sequence',
    IDBKeyRange.bound(
      [ownerKey, targetKey, 0],
      [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
    ),
  ) as SyncOutboxEventV5[];
  return events.sort(eventSort);
};

const defaultSyncMeta = (
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

const validateEnqueueInput = (input: EnqueueProgressInput) => {
  if (!input.bookId || !input.deviceId || !input.sessionId) {
    throw new Error('진행률 event 식별자가 비어 있습니다.');
  }
  if (input.operation === 'progress.set' && !isProgressPositionV2(input.position)) {
    throw new Error('progress.set payload가 올바르지 않습니다.');
  }
  if (input.operation === 'progress.reset' && input.position !== null) {
    throw new Error('progress.reset payload는 null이어야 합니다.');
  }
};

const validateBookmarkEnqueueInput = (input: EnqueueBookmarkInput) => {
  if (!input.bookId || !input.bookmarkId || !input.deviceId || !input.sessionId) {
    throw new Error('북마크 event 식별자가 비어 있습니다.');
  }
  if (
    input.operation === 'bookmark.upsert'
      ? !isManualBookmarkPayloadV2(input.payload)
        || input.payload.bookmarkId !== input.bookmarkId
      : input.payload !== null
  ) throw new Error('북마크 event payload가 올바르지 않습니다.');
};

const validateAnnotationEnqueueInput = (input: EnqueueAnnotationInputV5) => {
  if (!input.bookId || !input.annotationId) {
    throw new Error('annotation event 식별자가 비어 있습니다.');
  }
  if (
    input.operation === 'annotation.upsert'
      ? !isAnnotationSyncPayloadV1(input.payload)
        || input.payload.bookId !== input.bookId
        || input.payload.id !== input.annotationId
      : input.payload !== null
  ) throw new Error('annotation event payload가 올바르지 않습니다.');
  if (input.forceDelete && input.operation !== 'annotation.delete') {
    throw new Error('annotation 강제 삭제는 delete event에서만 사용할 수 있습니다.');
  }
  if (
    input.baseRevision !== undefined
    && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
  ) throw new Error('annotation event base revision이 올바르지 않습니다.');
};

type AnnotationOutboxTransactionV5 = IDBPTransaction<
  unknown,
  string[],
  'readwrite'
>;

export const appendAnnotationEventsToTransactionV5 = async (
  tx: AnnotationOutboxTransactionV5,
  ownerKey: OwnerKey,
  inputs: ReadonlyArray<EnqueueAnnotationInputV5>,
  context: AnnotationSyncContextV5,
) => {
  if (!context.deviceId || !context.sessionId) {
    throw new Error('annotation sync context가 올바르지 않습니다.');
  }
  inputs.forEach(validateAnnotationEnqueueInput);
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const created: AnnotationOutboxEventV5[] = [];
  for (const input of inputs) {
    const now = input.occurredAtClient ?? Date.now();
    const targetKey = annotationTargetKeyV1(input.bookId, input.annotationId);
    const [storedMeta, targetEvents, openConflicts] = await Promise.all([
      metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
      outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<SyncOutboxEventV5[]>,
      conflictStore.index('by-owner-target-state').getAll([
        ownerKey,
        targetKey,
        'open',
      ]) as Promise<SyncConflictV5[]>,
    ]);
    const openConflict = openConflicts[0];
    if (openConflict && !input.forceDelete) {
      await conflictStore.put({ ...openConflict, latestLocalPosition: input.payload });
      continue;
    }
    const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, now);
    let unresolved = targetEvents.filter((event) => activeStatuses.has(event.status));
    if (input.forceDelete) {
      for (const event of unresolved) {
        await outboxStore.put({
          ...event,
          status: 'superseded',
          claimedByTabId: null,
          claimedLeaseEpoch: null,
          claimToken: null,
        });
      }
      for (const conflict of openConflicts) {
        await conflictStore.put({ ...conflict, state: 'resolved_local', resolvedAt: now });
      }
      unresolved = [];
    }
    const coalesced = [...unresolved].reverse().find((event): event is AnnotationOutboxEventV5 => (
      event.target.kind === 'annotation'
      && event.status === 'pending'
      && event.sessionId === context.sessionId
      && event.claimedByTabId === null
    ));
    if (coalesced) {
      const updated: AnnotationOutboxEventV5 = {
        ...coalesced,
        operation: input.operation,
        payload: input.payload,
        occurredAtClient: now,
        baseRevision: input.baseRevision ?? coalesced.baseRevision,
        forceDelete: input.forceDelete ?? coalesced.forceDelete,
        nextAttemptAt: now,
        lastErrorCode: null,
      };
      await outboxStore.put(updated);
      created.push(updated);
      continue;
    }
    const event: AnnotationOutboxEventV5 = {
      ownerKey,
      eventId: input.eventId ?? context.createEventId?.() ?? crypto.randomUUID(),
      target: {
        kind: 'annotation',
        bookId: input.bookId,
        annotationId: input.annotationId,
      },
      targetKey,
      operation: input.operation,
      payload: input.payload,
      deviceId: context.deviceId,
      sessionId: context.sessionId,
      sequence: meta.nextSequence,
      baseRevision: meta.knownRevision + unresolved.length,
      ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
      ...(input.forceDelete ? { forceDelete: true } : {}),
      occurredAtClient: now,
      status: unresolved.some((candidate) => (
        candidate.status === 'blocked' || candidate.status === 'conflict'
      )) ? 'blocked' : 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    };
    await Promise.all([
      outboxStore.add(event),
      metaStore.put({
        ...meta,
        knownRevision: Math.max(meta.knownRevision, input.baseRevision ?? 0),
        nextSequence: meta.nextSequence + 1,
        updatedAt: now,
      }),
    ]);
    created.push(event);
  }
  return created;
};

export const enqueueAnnotationEventsV5 = async (
  ownerKey: OwnerKey,
  inputs: ReadonlyArray<EnqueueAnnotationInputV5>,
  context: AnnotationSyncContextV5,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  const events = await appendAnnotationEventsToTransactionV5(
    tx as AnnotationOutboxTransactionV5,
    ownerKey,
    inputs,
    context,
  );
  await tx.done;
  if (events.length > 0) notifyProgressSyncWork(ownerKey);
  return events;
};

export const enqueueAnnotationPaletteEventV5 = async (
  ownerKey: OwnerKey,
  input: EnqueueAnnotationPaletteInputV5,
  context: AnnotationSyncContextV5,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  const result = await appendAnnotationPaletteEventToTransactionV5(
    tx,
    ownerKey,
    input,
    context,
  );
  await tx.done;
  if (!result.deferredByConflict) notifyProgressSyncWork(ownerKey);
  return result;
};

export const appendAnnotationPaletteEventToTransactionV5 = async (
  tx: AnnotationOutboxTransactionV5,
  ownerKey: OwnerKey,
  input: EnqueueAnnotationPaletteInputV5,
  context: AnnotationSyncContextV5,
) => {
  if (
    !context.deviceId
    || !context.sessionId
    || !isAnnotationPalettePayloadV1(input.payload)
  ) throw new Error('annotation palette event payload가 올바르지 않습니다.');
  const now = input.occurredAtClient ?? Date.now();
  const targetKey = annotationPaletteTargetKeyV1();
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const [storedMeta, targetEvents, openConflicts] = await Promise.all([
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
    outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
      [ownerKey, targetKey, 0],
      [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
    )) as Promise<SyncOutboxEventV5[]>,
    conflictStore.index('by-owner-target-state').getAll([
      ownerKey,
      targetKey,
      'open',
    ]) as Promise<SyncConflictV5[]>,
  ]);
  const openConflict = openConflicts[0];
  if (openConflict) {
    await conflictStore.put({ ...openConflict, latestLocalPosition: input.payload });
    return { event: openConflict.event, deferredByConflict: true };
  }
  const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, now);
  const unresolved = targetEvents.filter((event) => activeStatuses.has(event.status));
  const coalesced = [...unresolved].reverse().find((event): event is AnnotationPaletteOutboxEventV5 => (
    event.target.kind === 'palette'
    && event.status === 'pending'
    && event.sessionId === context.sessionId
    && event.claimedByTabId === null
  ));
  if (coalesced) {
    const updated: AnnotationPaletteOutboxEventV5 = {
      ...coalesced,
      payload: input.payload,
      occurredAtClient: now,
      nextAttemptAt: now,
      lastErrorCode: null,
    };
    await outboxStore.put(updated);
    return { event: updated, deferredByConflict: false };
  }
  const event: AnnotationPaletteOutboxEventV5 = {
    ownerKey,
    eventId: input.eventId ?? context.createEventId?.() ?? crypto.randomUUID(),
    target: { kind: 'palette' },
    targetKey,
    operation: 'palette.set',
    payload: input.payload,
    deviceId: context.deviceId,
    sessionId: context.sessionId,
    sequence: meta.nextSequence,
    baseRevision: meta.knownRevision + unresolved.length,
    occurredAtClient: now,
    status: unresolved.some((candidate) => (
      candidate.status === 'blocked' || candidate.status === 'conflict'
    )) ? 'blocked' : 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  };
  await Promise.all([
    outboxStore.add(event),
    metaStore.put({
      ...meta,
      nextSequence: meta.nextSequence + 1,
      updatedAt: now,
    }),
  ]);
  return { event, deferredByConflict: false };
};

const toLocalProgress = (
  input: EnqueueProgressInput,
  existing: UserProgress | undefined,
  occurredAtClient: number,
): UserProgress => input.operation === 'progress.set'
  ? {
    bookId: input.bookId,
    cfi: input.position!.cfi,
    anchorCfi: input.position!.anchorCfi ?? input.position!.cfi,
    progressPercent: input.position!.progressPercent,
    lastRead: occurredAtClient,
    bookmarks: input.localBookmarks ?? existing?.bookmarks ?? [],
  }
  : {
    bookId: input.bookId,
    cfi: '',
    anchorCfi: '',
    progressPercent: 0,
    lastRead: occurredAtClient,
    bookmarks: input.localBookmarks ?? existing?.bookmarks ?? [],
  };

export const enqueueProgressEventV5 = async (
  ownerKey: OwnerKey,
  input: EnqueueProgressInput,
) => {
  validateEnqueueInput(input);
  const occurredAtClient = input.occurredAtClient ?? Date.now();
  const targetKey = progressTargetKeyV2(input.bookId);
  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  // Individual request errors reject before tx.done; attach a handler so an
  // automatic rollback never becomes a second unhandled rejection.
  void tx.done.catch(() => undefined);
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const [existingProgress, storedMeta, targetEvents, openConflicts] = await Promise.all([
    progressStore.get([ownerKey, input.bookId]) as Promise<UserProgress | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
    outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
      [ownerKey, targetKey, 0],
      [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
    )) as Promise<ProgressOutboxEventV5[]>,
    conflictStore.index('by-owner-target-state').getAll([
      ownerKey,
      targetKey,
      'open',
    ]) as Promise<SyncConflictV5[]>,
  ]);
  const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, occurredAtClient);
  const unresolved = targetEvents.filter((event) => activeStatuses.has(event.status)).sort(eventSort);
  const coalesced = input.operation === 'progress.set'
    ? [...unresolved].reverse().find((event) => (
      event.operation === 'progress.set'
      && event.status === 'pending'
      && event.sessionId === input.sessionId
      && event.claimedByTabId === null
    ))
    : undefined;

  await progressStore.put({
    ...toLocalProgress(input, existingProgress, occurredAtClient),
    ownerKey,
  });

  const openConflict = openConflicts[0];
  if (openConflict) {
    await conflictStore.put({
      ...openConflict,
      latestLocalPosition: input.position,
    });
    await tx.done;
    return {
      event: openConflict.event,
      coalesced: false,
      deferredByConflict: true,
    };
  }

  if (coalesced) {
    const updated: ProgressOutboxEventV5 = {
      ...coalesced,
      payload: input.position,
      occurredAtClient,
      nextAttemptAt: occurredAtClient,
      lastErrorCode: null,
    };
    await outboxStore.put(updated);
    await tx.done;
    notifyProgressSyncWork(ownerKey);
    return { event: updated, coalesced: true, deferredByConflict: false };
  }

  const event: ProgressOutboxEventV5 = {
    ownerKey,
    eventId: input.eventId ?? crypto.randomUUID(),
    target: { kind: 'progress', bookId: input.bookId },
    targetKey,
    operation: input.operation,
    payload: input.position,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    sequence: meta.nextSequence,
    baseRevision: meta.knownRevision + unresolved.length,
    occurredAtClient,
    status: unresolved.some((candidate) => (
      candidate.status === 'blocked' || candidate.status === 'conflict'
    )) ? 'blocked' : 'pending',
    attempts: 0,
    nextAttemptAt: occurredAtClient,
    lastErrorCode: null,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  };
  await Promise.all([
    outboxStore.add(event),
    metaStore.put({
      ...meta,
      nextSequence: meta.nextSequence + 1,
      updatedAt: occurredAtClient,
    }),
  ]);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return { event, coalesced: false, deferredByConflict: false };
};

export const enqueueBookmarkEventV5 = async (
  ownerKey: OwnerKey,
  input: EnqueueBookmarkInput,
) => {
  validateBookmarkEnqueueInput(input);

  const now = input.occurredAtClient ?? Date.now();
  const targetKey = bookmarkTargetKeyV2(input.bookId, input.bookmarkId);
  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const [existingProgress, storedMeta, targetEvents, openConflicts] = await Promise.all([
    progressStore.get([ownerKey, input.bookId]) as Promise<(UserProgress & { ownerKey?: OwnerKey }) | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
    outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
      [ownerKey, targetKey, 0],
      [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
    )) as Promise<SyncOutboxEventV5[]>,
    conflictStore.index('by-owner-target-state').getAll([
      ownerKey,
      targetKey,
      'open',
    ]) as Promise<SyncConflictV5[]>,
  ]);
  await progressStore.put({
    bookId: input.bookId,
    cfi: existingProgress?.cfi ?? '',
    anchorCfi: existingProgress?.anchorCfi ?? '',
    progressPercent: existingProgress?.progressPercent ?? 0,
    lastRead: existingProgress?.lastRead ?? now,
    bookmarks: input.localBookmarks,
    ownerKey,
  });

  const openConflict = openConflicts[0];
  if (openConflict) {
    await conflictStore.put({ ...openConflict, latestLocalPosition: input.payload });
    await tx.done;
    return { event: openConflict.event, deferredByConflict: true };
  }

  const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, now);
  const unresolved = targetEvents.filter((event) => activeStatuses.has(event.status));
  const event: BookmarkOutboxEventV5 = {
    ownerKey,
    eventId: input.eventId ?? crypto.randomUUID(),
    target: {
      kind: 'bookmark',
      bookId: input.bookId,
      bookmarkId: input.bookmarkId,
    },
    targetKey,
    operation: input.operation,
    payload: input.payload,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    sequence: meta.nextSequence,
    baseRevision: meta.knownRevision + unresolved.length,
    occurredAtClient: now,
    status: unresolved.some((candidate) => (
      candidate.status === 'blocked' || candidate.status === 'conflict'
    )) ? 'blocked' : 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  };
  await Promise.all([
    outboxStore.add(event),
    metaStore.put({
      ...meta,
      nextSequence: meta.nextSequence + 1,
      updatedAt: now,
    }),
  ]);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return { event, deferredByConflict: false };
};

export const enqueueProgressMutationBatchV5 = async (
  ownerKey: OwnerKey,
  input: EnqueueProgressMutationBatchInput,
) => {
  if (input.progressEvent) validateEnqueueInput(input.progressEvent);
  input.bookmarkEvents.forEach(validateBookmarkEnqueueInput);
  if (
    input.progressEvent?.bookId !== undefined
    && input.progressEvent.bookId !== input.progress.bookId
  ) throw new Error('progress batch의 bookId가 일치하지 않습니다.');
  if (
    input.progressEvent?.operation === 'progress.reset'
    && (input.progress.cfi !== '' || input.progress.progressPercent !== 0)
  ) throw new Error('progress reset batch의 로컬 상태가 일치하지 않습니다.');
  if (
    input.progressEvent?.operation === 'progress.set'
    && (
      input.progress.cfi !== input.progressEvent.position?.cfi
      || input.progress.progressPercent !== input.progressEvent.position?.progressPercent
    )
  ) throw new Error('progress set batch의 로컬 상태가 일치하지 않습니다.');
  if (input.bookmarkEvents.some(({ bookId }) => bookId !== input.progress.bookId)) {
    throw new Error('bookmark batch의 bookId가 일치하지 않습니다.');
  }

  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_META_STORE,
    V5_SYNC_CONFLICTS_STORE,
  ], 'readwrite');
  void tx.done.catch(() => undefined);
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const outboxStore = tx.objectStore(V5_OUTBOX_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);

  if (input.progressEvent) {
    const eventInput = input.progressEvent;
    const occurredAtClient = eventInput.occurredAtClient ?? Date.now();
    const targetKey = progressTargetKeyV2(eventInput.bookId);
    const [storedMeta, targetEvents, openConflicts] = await Promise.all([
      metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
      outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<ProgressOutboxEventV5[]>,
      conflictStore.index('by-owner-target-state').getAll([
        ownerKey,
        targetKey,
        'open',
      ]) as Promise<SyncConflictV5[]>,
    ]);
    const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, occurredAtClient);
    const unresolved = targetEvents
      .filter((event) => activeStatuses.has(event.status))
      .sort(eventSort);
    const coalesced = eventInput.operation === 'progress.set'
      ? [...unresolved].reverse().find((event) => (
        event.operation === 'progress.set'
        && event.status === 'pending'
        && event.sessionId === eventInput.sessionId
        && event.claimedByTabId === null
      ))
      : undefined;
    const openConflict = openConflicts[0];
    if (openConflict) {
      await conflictStore.put({ ...openConflict, latestLocalPosition: eventInput.position });
    } else if (coalesced) {
      await outboxStore.put({
        ...coalesced,
        payload: eventInput.position,
        occurredAtClient,
        nextAttemptAt: occurredAtClient,
        lastErrorCode: null,
      });
    } else {
      const event: ProgressOutboxEventV5 = {
        ownerKey,
        eventId: eventInput.eventId ?? crypto.randomUUID(),
        target: { kind: 'progress', bookId: eventInput.bookId },
        targetKey,
        operation: eventInput.operation,
        payload: eventInput.position,
        deviceId: eventInput.deviceId,
        sessionId: eventInput.sessionId,
        sequence: meta.nextSequence,
        baseRevision: meta.knownRevision + unresolved.length,
        occurredAtClient,
        status: unresolved.some((candidate) => (
          candidate.status === 'blocked' || candidate.status === 'conflict'
        )) ? 'blocked' : 'pending',
        attempts: 0,
        nextAttemptAt: occurredAtClient,
        lastErrorCode: null,
        claimedByTabId: null,
        claimedLeaseEpoch: null,
        claimToken: null,
      };
      await Promise.all([
        outboxStore.add(event),
        metaStore.put({
          ...meta,
          nextSequence: meta.nextSequence + 1,
          updatedAt: occurredAtClient,
        }),
      ]);
    }
  }

  for (const eventInput of input.bookmarkEvents) {
    const now = eventInput.occurredAtClient ?? Date.now();
    const targetKey = bookmarkTargetKeyV2(eventInput.bookId, eventInput.bookmarkId);
    const [storedMeta, targetEvents, openConflicts] = await Promise.all([
      metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
      outboxStore.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
        [ownerKey, targetKey, 0],
        [ownerKey, targetKey, Number.MAX_SAFE_INTEGER],
      )) as Promise<SyncOutboxEventV5[]>,
      conflictStore.index('by-owner-target-state').getAll([
        ownerKey,
        targetKey,
        'open',
      ]) as Promise<SyncConflictV5[]>,
    ]);
    const meta = storedMeta ?? defaultSyncMeta(ownerKey, targetKey, now);
    const unresolved = targetEvents.filter((event) => activeStatuses.has(event.status));
    const openConflict = openConflicts[0];
    if (openConflict) {
      await conflictStore.put({ ...openConflict, latestLocalPosition: eventInput.payload });
      continue;
    }
    const event: BookmarkOutboxEventV5 = {
      ownerKey,
      eventId: eventInput.eventId ?? crypto.randomUUID(),
      target: {
        kind: 'bookmark',
        bookId: eventInput.bookId,
        bookmarkId: eventInput.bookmarkId,
      },
      targetKey,
      operation: eventInput.operation,
      payload: eventInput.payload,
      deviceId: eventInput.deviceId,
      sessionId: eventInput.sessionId,
      sequence: meta.nextSequence,
      baseRevision: meta.knownRevision + unresolved.length,
      occurredAtClient: now,
      status: unresolved.some((candidate) => (
        candidate.status === 'blocked' || candidate.status === 'conflict'
      )) ? 'blocked' : 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    };
    await Promise.all([
      outboxStore.add(event),
      metaStore.put({
        ...meta,
        nextSequence: meta.nextSequence + 1,
        updatedAt: now,
      }),
    ]);
  }

  await progressStore.put({ ...input.progress, ownerKey });
  await tx.done;
  if (input.progressEvent || input.bookmarkEvents.length > 0) {
    notifyProgressSyncWork(ownerKey);
  }
};

export const getOutboxEventsV5 = async (
  ownerKey: OwnerKey,
  targetKey?: string,
) => {
  const db = await initDB();
  if (targetKey) return getTargetEvents(db, ownerKey, targetKey);
  const events = await db.getAll(V5_OUTBOX_STORE) as SyncOutboxEventV5[];
  return events.filter((event) => event.ownerKey === ownerKey).sort(eventSort);
};

export const getSyncMetaV5 = async (ownerKey: OwnerKey, targetKey: string) => {
  const db = await initDB();
  return db.get(V5_SYNC_META_STORE, [ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>;
};

export const acknowledgeProgressEventV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  head: SyncHeadV2,
  expectedClaim: ExpectedClaimV5,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_OUTBOX_STORE,
    V5_PROGRESS_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const event = await outbox.get([ownerKey, eventId]) as SyncOutboxEventV5 | undefined;
  if (!event || !ownsExpectedClaim(event, expectedClaim)) {
    await tx.done;
    return false;
  }
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const meta = await metaStore.get([ownerKey, event.targetKey]) as SyncMetaV5 | undefined;
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const progress = event.target.kind === 'progress' && 'position' in head
    ? await progressStore.get([ownerKey, event.target.bookId]) as
      (UserProgress & { ownerKey: OwnerKey }) | undefined
    : undefined;
  await Promise.all([
    outbox.delete([ownerKey, eventId]),
    tx.objectStore(V5_REMOTE_HEADS_STORE).put({
      ownerKey,
      targetKey: event.targetKey,
      revision: head.revision,
      head,
      updatedAt: now,
    } satisfies RemoteHeadCacheV5),
    metaStore.put({
      ...(meta ?? defaultSyncMeta(ownerKey, event.targetKey, now)),
      knownRevision: Math.max(meta?.knownRevision ?? 0, head.revision),
      updatedAt: now,
    }),
    progress
      ? progressStore.put({
        ...progress,
        syncRevision: head.revision,
        acceptedEventId: head.acceptedEventId,
      })
      : Promise.resolve(),
  ]);
  await tx.done;
  return true;
};

export const recordProgressConflictV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  remoteHead: SyncHeadV2 | null,
  expectedClaim: ExpectedClaimV5,
  now = Date.now(),
  conflictReason?: AnnotationAggregateConflictReasonV1,
) => {
  const db = await initDB();
  const tx = db.transaction([V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const event = await outbox.get([ownerKey, eventId]) as SyncOutboxEventV5 | undefined;
  if (!event || !ownsExpectedClaim(event, expectedClaim)) {
    await tx.done;
    return false;
  }
  const events = await outbox.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
    [ownerKey, event.targetKey, event.sequence],
    [ownerKey, event.targetKey, Number.MAX_SAFE_INTEGER],
  )) as SyncOutboxEventV5[];
  const blockedEventIds: string[] = [];
  for (const candidate of events) {
    if (candidate.eventId === eventId) {
      await outbox.put({
        ...candidate,
        status: 'conflict',
        claimedByTabId: null,
        claimedLeaseEpoch: null,
        claimToken: null,
      });
    } else if (activeStatuses.has(candidate.status)) {
      blockedEventIds.push(candidate.eventId);
      await outbox.put({
        ...candidate,
        status: 'blocked',
        claimedByTabId: null,
        claimedLeaseEpoch: null,
        claimToken: null,
      });
    }
  }
  const conflict: SyncConflictV5 = {
    ownerKey,
    conflictId: event.eventId,
    targetKey: event.targetKey,
    state: 'open',
    event: { ...event, status: 'conflict' },
    remoteHead,
    ...(conflictReason ? { conflictReason } : {}),
    latestLocalPosition: event.payload,
    blockedEventIds,
    createdAt: now,
  };
  await tx.objectStore(V5_SYNC_CONFLICTS_STORE).put(conflict);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return conflict;
};

export const acquireSyncLeaseV5 = async (
  ownerKey: OwnerKey,
  tabId: string,
  now = Date.now(),
  durationMs = 15_000,
) => {
  const db = await initDB();
  const tx = db.transaction(V5_SYNC_LEASES_STORE, 'readwrite');
  const store = tx.objectStore(V5_SYNC_LEASES_STORE);
  const existing = await store.get(ownerKey) as SyncLeaseV5 | undefined;
  if (
    existing
    && existing.holderTabId !== tabId
    && existing.expiresAt > now
  ) {
    await tx.done;
    return null;
  }
  const continuesLiveLease = existing?.holderTabId === tabId
    && existing.expiresAt > now;
  const lease: SyncLeaseV5 = {
    ownerKey,
    holderTabId: tabId,
    epoch: continuesLiveLease
      ? existing.epoch
      : (existing?.epoch ?? 0) + 1,
    expiresAt: now + durationMs,
    heartbeatAt: now,
  };
  await store.put(lease);
  await tx.done;
  return lease;
};

export const claimNextProgressEventV5 = async (
  ownerKey: OwnerKey,
  tabId: string,
  leaseEpoch: number,
  now = Date.now(),
  createClaimToken = () => crypto.randomUUID(),
) => {
  const db = await initDB();
  const tx = db.transaction([V5_SYNC_LEASES_STORE, V5_OUTBOX_STORE], 'readwrite');
  const lease = await tx.objectStore(V5_SYNC_LEASES_STORE).get(ownerKey) as SyncLeaseV5 | undefined;
  if (
    !lease
    || lease.holderTabId !== tabId
    || lease.epoch !== leaseEpoch
    || lease.expiresAt <= now
  ) {
    await tx.done;
    return null;
  }
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const events = await outbox.index('by-owner-status-next-attempt').getAll(
    IDBKeyRange.bound(
      [ownerKey, 'pending', 0],
      [ownerKey, 'pending', now],
    ),
  ) as SyncOutboxEventV5[];
  events.sort(eventSort);
  let candidate: SyncOutboxEventV5 | undefined;
  for (const event of events) {
    const targetEvents = await outbox.index('by-owner-target-sequence').getAll(
      IDBKeyRange.bound(
        [ownerKey, event.targetKey, 0],
        [ownerKey, event.targetKey, event.sequence - 1],
      ),
    ) as SyncOutboxEventV5[];
    if (!targetEvents.some((earlier) => activeStatuses.has(earlier.status))) {
      candidate = event;
      break;
    }
  }
  if (!candidate) {
    await tx.done;
    return null;
  }
  const claimed: SyncOutboxEventV5 = {
    ...candidate,
    status: 'in_flight',
    attempts: candidate.attempts + 1,
    claimedByTabId: tabId,
    claimedLeaseEpoch: leaseEpoch,
    claimToken: createClaimToken(),
  };
  await outbox.put(claimed);
  await tx.done;
  return claimed;
};

export const recoverExpiredInFlightEventsV5 = async (
  ownerKey: OwnerKey,
  tabId: string,
  leaseEpoch: number,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([V5_SYNC_LEASES_STORE, V5_OUTBOX_STORE], 'readwrite');
  const lease = await tx.objectStore(V5_SYNC_LEASES_STORE).get(ownerKey) as SyncLeaseV5 | undefined;
  if (
    !lease
    || lease.holderTabId !== tabId
    || lease.epoch !== leaseEpoch
    || lease.expiresAt <= now
  ) {
    await tx.done;
    return 0;
  }
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const events = await outbox.index('by-owner-status').getAll([
    ownerKey,
    'in_flight',
  ]) as SyncOutboxEventV5[];
  let recovered = 0;
  for (const event of events) {
    if (
      event.claimedLeaseEpoch === leaseEpoch
    ) continue;
    recovered += 1;
    await outbox.put({
      ...event,
      status: 'pending',
      nextAttemptAt: now,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    });
  }
  await tx.done;
  return recovered;
};

export const getRetryDelayMs = (
  attempts: number,
  random = Math.random(),
) => {
  const base = Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
  const jitter = Math.floor(base * 0.2 * Math.min(1, Math.max(0, random)));
  return Math.min(60_000, base + jitter);
};

export const scheduleProgressEventRetryV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  errorCode: string,
  expectedClaim: ExpectedClaimV5,
  now = Date.now(),
  random = Math.random(),
) => {
  const db = await initDB();
  const tx = db.transaction(V5_OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const event = await store.get([ownerKey, eventId]) as SyncOutboxEventV5 | undefined;
  if (!event || !ownsExpectedClaim(event, expectedClaim)) {
    await tx.done;
    return null;
  }
  const updated: SyncOutboxEventV5 = {
    ...event,
    status: 'pending',
    nextAttemptAt: now + getRetryDelayMs(event.attempts, random),
    lastErrorCode: errorCode,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  };
  await store.put(updated);
  await tx.done;
  notifyProgressSyncWorkAfter(ownerKey, updated.nextAttemptAt! - Date.now());
  return updated;
};

export const releaseSyncLeaseV5 = async (
  ownerKey: OwnerKey,
  tabId: string,
  epoch: number,
) => {
  const db = await initDB();
  const tx = db.transaction(V5_SYNC_LEASES_STORE, 'readwrite');
  const store = tx.objectStore(V5_SYNC_LEASES_STORE);
  const lease = await store.get(ownerKey) as SyncLeaseV5 | undefined;
  if (lease?.holderTabId === tabId && lease.epoch === epoch) {
    // Keep the generation record so a later tab can never reuse this epoch.
    await store.put({ ...lease, expiresAt: 0, heartbeatAt: Date.now() });
  }
  await tx.done;
};

export const isSyncLeaseCurrentV5 = async (
  ownerKey: OwnerKey,
  tabId: string,
  epoch: number,
  now = Date.now(),
) => {
  const db = await initDB();
  const lease = await db.get(V5_SYNC_LEASES_STORE, ownerKey) as SyncLeaseV5 | undefined;
  return Boolean(
    lease
    && lease.holderTabId === tabId
    && lease.epoch === epoch
    && lease.expiresAt > now,
  );
};

export const pauseProgressEventV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  errorCode: string,
  expectedClaim: ExpectedClaimV5,
) => {
  const db = await initDB();
  const tx = db.transaction(V5_OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const event = await store.get([ownerKey, eventId]) as SyncOutboxEventV5 | undefined;
  if (!event || !ownsExpectedClaim(event, expectedClaim)) {
    await tx.done;
    return null;
  }
  const paused: SyncOutboxEventV5 = {
    ...event,
    status: 'paused',
    nextAttemptAt: null,
    lastErrorCode: errorCode,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
    claimToken: null,
  };
  await store.put(paused);
  await tx.done;
  return paused;
};

export type PausedSyncSummaryV5 = {
  count: number;
  errorCodes: string[];
};

export const getPausedSyncSummaryV5 = async (
  ownerKey: OwnerKey,
): Promise<PausedSyncSummaryV5> => {
  const db = await initDB();
  const events = await db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status', [
    ownerKey,
    'paused',
  ]) as SyncOutboxEventV5[];
  return {
    count: events.length,
    errorCodes: [...new Set(events.map((event) => event.lastErrorCode ?? 'unknown'))],
  };
};

// A permission error may be caused by an app/rules deployment race. Retry it
// once when a fresh app session or online transition starts; persistent errors
// pause again and remain visible instead of polling continuously.
const resumableAuthCodes = new Set([
  'unauthenticated',
  'auth/user-token-expired',
  'auth/id-token-expired',
  'permission-denied',
]);

export const resumePausedAuthEventsV5 = async (
  ownerKey: OwnerKey,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction(V5_OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const events = await store.index('by-owner-status').getAll([
    ownerKey,
    'paused',
  ]) as SyncOutboxEventV5[];
  let resumed = 0;
  for (const event of events) {
    if (!event.lastErrorCode || !resumableAuthCodes.has(event.lastErrorCode)) continue;
    resumed += 1;
    await store.put({
      ...event,
      status: 'pending',
      nextAttemptAt: now,
      lastErrorCode: null,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    });
  }
  await tx.done;
  if (resumed > 0) notifyProgressSyncWork(ownerKey);
  return resumed;
};

export const getOpenSyncConflictsV5 = async (ownerKey: OwnerKey) => {
  const db = await initDB();
  const tx = db.transaction(V5_SYNC_CONFLICTS_STORE, 'readonly');
  const index = tx.objectStore(V5_SYNC_CONFLICTS_STORE).index('by-owner-state-created-at');
  const [open, deferred] = await Promise.all([
    index.getAll(IDBKeyRange.bound(
      [ownerKey, 'open', 0],
      [ownerKey, 'open', Number.MAX_SAFE_INTEGER],
    )) as Promise<SyncConflictV5[]>,
    index.getAll(IDBKeyRange.bound(
      [ownerKey, 'deferred', 0],
      [ownerKey, 'deferred', Number.MAX_SAFE_INTEGER],
    )) as Promise<SyncConflictV5[]>,
  ]);
  await tx.done;
  return [...open, ...deferred].sort((left, right) => left.createdAt - right.createdAt);
};

const supersedeConflictEvents = async (
  outbox: IDBPObjectStore<unknown, string[], typeof V5_OUTBOX_STORE, 'readwrite'>,
  conflict: SyncConflictV5,
) => {
  const eventIds = [conflict.event?.eventId, ...conflict.blockedEventIds]
    .filter((eventId): eventId is string => Boolean(eventId));
  for (const eventId of eventIds) {
    const event = await outbox.get([conflict.ownerKey, eventId]) as
      SyncOutboxEventV5 | undefined;
    if (event) await outbox.put({
      ...event,
      status: 'superseded',
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    });
  }
};

export const resolveSyncConflictUseRemoteV5 = async (
  ownerKey: OwnerKey,
  conflictId: string,
  now = Date.now(),
  preserveLocalProgress = false,
  expectedLocalPosition?: ProgressPositionV2,
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_SYNC_META_STORE,
    V5_REMOTE_HEADS_STORE,
  ], 'readwrite');
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const conflict = await conflictStore.get([ownerKey, conflictId]) as SyncConflictV5 | undefined;
  if (!conflict?.event || !conflict.remoteHead) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('적용할 원격 충돌 데이터가 없습니다.');
  }
  if (
    (conflict.event.target.kind !== 'progress' && conflict.event.target.kind !== 'bookmark')
    || (!('position' in conflict.remoteHead) && !('bookmarkId' in conflict.remoteHead))
  ) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('annotation 충돌은 전용 resolver에서 처리해야 합니다.');
  }
  if (expectedLocalPosition) {
    const latest = conflict.latestLocalPosition;
    const stillMatches = Boolean(
      (conflict.state === 'open' || conflict.state === 'deferred')
      && latest
      && 'anchorCfi' in latest
      && latest.cfi === expectedLocalPosition.cfi
      && (latest.anchorCfi ?? null) === (expectedLocalPosition.anchorCfi ?? null)
      && latest.progressPercent === expectedLocalPosition.progressPercent,
    );
    if (!stillMatches) {
      tx.abort();
      await tx.done.catch(() => undefined);
      return null;
    }
  }
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  await supersedeConflictEvents(outbox, conflict);
  const progressStore = tx.objectStore(V5_PROGRESS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const bookId = conflict.event.target.bookId;
  const existing = await progressStore.get([ownerKey, bookId]) as
    (UserProgress & { ownerKey: OwnerKey }) | undefined;

  const latestLocalPosition = conflict.latestLocalPosition
    && 'anchorCfi' in conflict.latestLocalPosition
      ? conflict.latestLocalPosition
      : null;
  const localPosition = conflict.event.target.kind === 'progress'
    && conflict.event.operation === 'progress.set'
    && conflict.event.payload
      ? latestLocalPosition ?? conflict.event.payload
      : null;
  const shouldPreserveLocalPosition = Boolean(
    preserveLocalProgress
    && localPosition
    && 'position' in conflict.remoteHead
    && conflict.remoteHead.operation === 'set'
    && conflict.remoteHead.position
    && (localPosition!.anchorCfi ?? localPosition!.cfi)
      !== (conflict.remoteHead.position.anchorCfi ?? conflict.remoteHead.position.cfi),
  );
  const recoveryBookmarks: Bookmark[] = shouldPreserveLocalPosition
    ? [
      ...(existing?.bookmarks ?? []).filter((bookmark) => bookmark.type === 'manual'),
      {
        id: crypto.randomUUID(),
        type: 'auto',
        name: '충돌 전 위치',
        cfi: localPosition!.cfi,
        progressPercent: localPosition!.progressPercent,
        createdAt: now,
        color: '#64748b',
      },
      ...(existing?.bookmarks ?? []).filter((bookmark) => bookmark.type === 'auto').slice(0, 2),
    ]
    : existing?.bookmarks ?? [];

  let nextProgress: UserProgress & { ownerKey: OwnerKey };
  if ('position' in conflict.remoteHead) {
    nextProgress = conflict.remoteHead.operation === 'reset'
      ? {
        ownerKey,
        bookId,
        cfi: '',
        anchorCfi: '',
        progressPercent: 0,
        lastRead: conflict.remoteHead.occurredAtClient,
        bookmarks: recoveryBookmarks,
        syncRevision: conflict.remoteHead.revision,
        acceptedEventId: conflict.remoteHead.acceptedEventId,
      }
      : {
        ownerKey,
        bookId,
        cfi: conflict.remoteHead.position!.cfi,
        anchorCfi: conflict.remoteHead.position!.anchorCfi
          ?? conflict.remoteHead.position!.cfi,
        progressPercent: conflict.remoteHead.position!.progressPercent,
        lastRead: conflict.remoteHead.occurredAtClient,
        bookmarks: recoveryBookmarks,
        syncRevision: conflict.remoteHead.revision,
        acceptedEventId: conflict.remoteHead.acceptedEventId,
      };
  } else {
    const bookmarks = new Map((existing?.bookmarks ?? [])
      .filter((bookmark) => bookmark.type === 'manual')
      .map((bookmark) => [bookmark.id, bookmark]));
    if (conflict.remoteHead.operation === 'delete') {
      bookmarks.delete(conflict.remoteHead.bookmarkId);
    } else {
      const payload = conflict.remoteHead.bookmark!;
      bookmarks.set(payload.bookmarkId, {
        id: payload.bookmarkId,
        type: 'manual',
        name: payload.name,
        cfi: payload.cfi,
        progressPercent: payload.progressPercent ?? undefined,
        createdAt: payload.createdAtClient,
        color: payload.color,
      });
    }
    nextProgress = {
      ownerKey,
      bookId,
      cfi: existing?.cfi ?? '',
      anchorCfi: existing?.anchorCfi ?? '',
      progressPercent: existing?.progressPercent ?? 0,
      lastRead: existing?.lastRead ?? now,
      bookmarks: [
        ...bookmarks.values(),
        ...(existing?.bookmarks ?? []).filter((bookmark) => bookmark.type === 'auto'),
      ],
      syncRevision: existing?.syncRevision,
      acceptedEventId: existing?.acceptedEventId,
    };
  }
  const meta = await metaStore.get([ownerKey, conflict.targetKey]) as SyncMetaV5 | undefined;
  await Promise.all([
    progressStore.put(nextProgress),
    metaStore.put({
      ...(meta ?? defaultSyncMeta(ownerKey, conflict.targetKey, now)),
      knownRevision: Math.max(meta?.knownRevision ?? 0, conflict.remoteHead.revision),
      updatedAt: now,
    }),
    remoteStore.put({
      ownerKey,
      targetKey: conflict.targetKey,
      revision: conflict.remoteHead.revision,
      head: conflict.remoteHead,
      updatedAt: now,
    } satisfies RemoteHeadCacheV5),
    conflictStore.put({ ...conflict, state: 'resolved_remote', resolvedAt: now }),
  ]);
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return nextProgress;
};

export const resolveSyncConflictKeepLocalV5 = async (
  ownerKey: OwnerKey,
  conflictId: string,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_PROGRESS_STORE,
    V5_OUTBOX_STORE,
    V5_SYNC_CONFLICTS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  const conflictStore = tx.objectStore(V5_SYNC_CONFLICTS_STORE);
  const conflict = await conflictStore.get([ownerKey, conflictId]) as SyncConflictV5 | undefined;
  if (!conflict?.event) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('유지할 로컬 충돌 데이터가 없습니다.');
  }
  if (conflict.event.target.kind !== 'progress' && conflict.event.target.kind !== 'bookmark') {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new Error('annotation 충돌은 전용 resolver에서 처리해야 합니다.');
  }
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  await supersedeConflictEvents(outbox, conflict);

  let target = conflict.event.target;
  let targetKey = conflict.event.targetKey;
  let payload = conflict.latestLocalPosition;
  let baseRevision = conflict.remoteHead?.revision ?? 0;
  const restoringDeletedBookmark = target.kind === 'bookmark'
    && conflict.remoteHead
    && 'bookmark' in conflict.remoteHead
    && conflict.remoteHead.operation === 'delete'
    && payload !== null;
  if (restoringDeletedBookmark && target.kind === 'bookmark') {
    const bookmarkId = crypto.randomUUID();
    target = { ...target, bookmarkId };
    targetKey = bookmarkTargetKeyV2(target.bookId, bookmarkId);
    payload = { ...(payload as ManualBookmarkPayloadV2), bookmarkId };
    baseRevision = 0;
  }

  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const meta = await metaStore.get([ownerKey, targetKey]) as SyncMetaV5 | undefined;
  const nextMeta = meta ?? defaultSyncMeta(ownerKey, targetKey, now);
  const replacement: SyncOutboxEventV5 = target.kind === 'progress'
    ? {
      ...conflict.event,
      eventId: crypto.randomUUID(),
      target,
      targetKey,
      operation: payload === null ? 'progress.reset' : 'progress.set',
      payload: payload as ProgressPositionV2 | null,
      sequence: nextMeta.nextSequence,
      baseRevision,
      occurredAtClient: now,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    }
    : {
      ...conflict.event,
      eventId: crypto.randomUUID(),
      target,
      targetKey,
      operation: payload === null ? 'bookmark.delete' : 'bookmark.upsert',
      payload: payload as ManualBookmarkPayloadV2 | null,
      sequence: nextMeta.nextSequence,
      baseRevision,
      occurredAtClient: now,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastErrorCode: null,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
      claimToken: null,
    };
  await Promise.all([
    outbox.add(replacement),
    metaStore.put({ ...nextMeta, nextSequence: nextMeta.nextSequence + 1, updatedAt: now }),
    conflictStore.put({ ...conflict, state: 'resolved_local', resolvedAt: now }),
  ]);

  if (restoringDeletedBookmark && replacement.target.kind === 'bookmark' && replacement.payload) {
    const progressStore = tx.objectStore(V5_PROGRESS_STORE);
    const existing = await progressStore.get([ownerKey, replacement.target.bookId]) as
      (UserProgress & { ownerKey: OwnerKey }) | undefined;
    if (existing) {
      const nextBookmarks = existing.bookmarks ?? [];
      const oldBookmarkId = conflict.event.target.kind === 'bookmark'
        ? conflict.event.target.bookmarkId
        : '';
      const restored = replacement.payload as ManualBookmarkPayloadV2;
      await progressStore.put({
        ...existing,
        bookmarks: [
          ...nextBookmarks.filter((bookmark) => bookmark.id !== oldBookmarkId),
          {
            id: restored.bookmarkId,
            type: 'manual',
            name: restored.name,
            cfi: restored.cfi,
            progressPercent: restored.progressPercent ?? undefined,
            createdAt: restored.createdAtClient,
            color: restored.color,
          },
        ],
      });
    }
  }
  await tx.done;
  notifyProgressSyncWork(ownerKey);
  return replacement;
};
