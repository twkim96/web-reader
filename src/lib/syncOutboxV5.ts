import type { IDBPDatabase } from 'idb';
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
  isProgressPositionV2,
  progressTargetKeyV2,
  type ProgressHeadV2,
  type ProgressPositionV2,
} from './progressV2Schema';

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
};

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
  head: ProgressHeadV2;
  updatedAt: number;
};

export type SyncConflictV5 = {
  ownerKey: OwnerKey;
  conflictId: string;
  targetKey: string;
  state: 'open' | 'resolved_local' | 'resolved_remote' | 'deferred' | 'remote_missing';
  event: ProgressOutboxEventV5 | null;
  remoteHead: ProgressHeadV2 | null;
  latestLocalPosition: ProgressPositionV2 | null;
  blockedEventIds: string[];
  createdAt: number;
  resolvedAt?: number;
};

export const storeRemoteProgressHeadV5 = async (
  ownerKey: OwnerKey,
  head: ProgressHeadV2,
  now = Date.now(),
) => {
  const targetKey = progressTargetKeyV2(head.bookId);
  const db = await initDB();
  const tx = db.transaction([V5_REMOTE_HEADS_STORE, V5_SYNC_META_STORE], 'readwrite');
  const remoteStore = tx.objectStore(V5_REMOTE_HEADS_STORE);
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const [existingRemote, existingMeta] = await Promise.all([
    remoteStore.get([ownerKey, targetKey]) as Promise<RemoteHeadCacheV5 | undefined>,
    metaStore.get([ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>,
  ]);
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
    ...(existingMeta ?? defaultSyncMeta(ownerKey, targetKey, now)),
    knownRevision: Math.max(existingMeta?.knownRevision ?? 0, head.revision),
    updatedAt: now,
  });
  await tx.done;
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
  await db.put(V5_SYNC_CONFLICTS_STORE, conflict);
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

const activeStatuses = new Set<OutboxStatusV5>([
  'pending', 'in_flight', 'blocked', 'conflict', 'paused',
]);

const eventSort = (a: ProgressOutboxEventV5, b: ProgressOutboxEventV5) => (
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
  ) as ProgressOutboxEventV5[];
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
  return { event, coalesced: false, deferredByConflict: false };
};

export const getOutboxEventsV5 = async (
  ownerKey: OwnerKey,
  targetKey?: string,
) => {
  const db = await initDB();
  if (targetKey) return getTargetEvents(db, ownerKey, targetKey);
  const events = await db.getAll(V5_OUTBOX_STORE) as ProgressOutboxEventV5[];
  return events.filter((event) => event.ownerKey === ownerKey).sort(eventSort);
};

export const getSyncMetaV5 = async (ownerKey: OwnerKey, targetKey: string) => {
  const db = await initDB();
  return db.get(V5_SYNC_META_STORE, [ownerKey, targetKey]) as Promise<SyncMetaV5 | undefined>;
};

export const acknowledgeProgressEventV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  head: ProgressHeadV2,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([
    V5_OUTBOX_STORE,
    V5_REMOTE_HEADS_STORE,
    V5_SYNC_META_STORE,
  ], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const event = await outbox.get([ownerKey, eventId]) as ProgressOutboxEventV5 | undefined;
  if (!event) {
    await tx.done;
    return false;
  }
  const metaStore = tx.objectStore(V5_SYNC_META_STORE);
  const meta = await metaStore.get([ownerKey, event.targetKey]) as SyncMetaV5 | undefined;
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
  ]);
  await tx.done;
  return true;
};

export const recordProgressConflictV5 = async (
  ownerKey: OwnerKey,
  eventId: string,
  remoteHead: ProgressHeadV2 | null,
  now = Date.now(),
) => {
  const db = await initDB();
  const tx = db.transaction([V5_OUTBOX_STORE, V5_SYNC_CONFLICTS_STORE], 'readwrite');
  const outbox = tx.objectStore(V5_OUTBOX_STORE);
  const event = await outbox.get([ownerKey, eventId]) as ProgressOutboxEventV5 | undefined;
  if (!event) throw new Error('충돌 event를 찾지 못했습니다.');
  const events = await outbox.index('by-owner-target-sequence').getAll(IDBKeyRange.bound(
    [ownerKey, event.targetKey, event.sequence],
    [ownerKey, event.targetKey, Number.MAX_SAFE_INTEGER],
  )) as ProgressOutboxEventV5[];
  const blockedEventIds: string[] = [];
  for (const candidate of events) {
    if (candidate.eventId === eventId) {
      await outbox.put({
        ...candidate,
        status: 'conflict',
        claimedByTabId: null,
        claimedLeaseEpoch: null,
      });
    } else if (activeStatuses.has(candidate.status)) {
      blockedEventIds.push(candidate.eventId);
      await outbox.put({
        ...candidate,
        status: 'blocked',
        claimedByTabId: null,
        claimedLeaseEpoch: null,
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
    latestLocalPosition: event.payload,
    blockedEventIds,
    createdAt: now,
  };
  await tx.objectStore(V5_SYNC_CONFLICTS_STORE).put(conflict);
  await tx.done;
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
  const lease: SyncLeaseV5 = {
    ownerKey,
    holderTabId: tabId,
    epoch: existing?.holderTabId === tabId
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
  const allEvents = (await outbox.getAll() as ProgressOutboxEventV5[])
    .filter((event) => event.ownerKey === ownerKey)
    .sort(eventSort);
  const events = allEvents.filter((event) => (
      event.ownerKey === ownerKey
      && event.status === 'pending'
      && (event.nextAttemptAt === null || event.nextAttemptAt <= now)
    ));
  const candidate = events.find((event) => !allEvents.some((earlier) => (
    earlier.targetKey === event.targetKey
    && earlier.sequence < event.sequence
    && activeStatuses.has(earlier.status)
  )));
  if (!candidate) {
    await tx.done;
    return null;
  }
  const claimed: ProgressOutboxEventV5 = {
    ...candidate,
    status: 'in_flight',
    attempts: candidate.attempts + 1,
    claimedByTabId: tabId,
    claimedLeaseEpoch: leaseEpoch,
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
  const events = await outbox.getAll() as ProgressOutboxEventV5[];
  let recovered = 0;
  for (const event of events) {
    if (
      event.ownerKey !== ownerKey
      || event.status !== 'in_flight'
      || event.claimedLeaseEpoch === leaseEpoch
    ) continue;
    recovered += 1;
    await outbox.put({
      ...event,
      status: 'pending',
      nextAttemptAt: now,
      claimedByTabId: null,
      claimedLeaseEpoch: null,
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
  now = Date.now(),
  random = Math.random(),
) => {
  const db = await initDB();
  const tx = db.transaction(V5_OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const event = await store.get([ownerKey, eventId]) as ProgressOutboxEventV5 | undefined;
  if (!event) {
    await tx.done;
    return null;
  }
  const updated: ProgressOutboxEventV5 = {
    ...event,
    status: 'pending',
    nextAttemptAt: now + getRetryDelayMs(event.attempts, random),
    lastErrorCode: errorCode,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
  };
  await store.put(updated);
  await tx.done;
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
  if (lease?.holderTabId === tabId && lease.epoch === epoch) await store.delete(ownerKey);
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
) => {
  const db = await initDB();
  const tx = db.transaction(V5_OUTBOX_STORE, 'readwrite');
  const store = tx.objectStore(V5_OUTBOX_STORE);
  const event = await store.get([ownerKey, eventId]) as ProgressOutboxEventV5 | undefined;
  if (!event) {
    await tx.done;
    return null;
  }
  const paused: ProgressOutboxEventV5 = {
    ...event,
    status: 'paused',
    nextAttemptAt: null,
    lastErrorCode: errorCode,
    claimedByTabId: null,
    claimedLeaseEpoch: null,
  };
  await store.put(paused);
  await tx.done;
  return paused;
};
