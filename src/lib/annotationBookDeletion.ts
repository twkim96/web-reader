import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_REMOTE_HEADS_STORE,
  V5_OUTBOX_STORE, V5_SYNC_META_STORE, V5_SYNC_CONFLICTS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import {
  appendAnnotationEventsToTransactionV5,
  getPendingSyncAuthorityId,
  isAnnotationOutboxEventV5,
  type AnnotationSyncContextV5,
  type PendingSyncAuthority, type SyncOutboxEventV5,
} from './syncOutboxV5';
import { finiteWriteLeasesEnabled, getTrustedWriteLeaseTime, readRecoverableSyncEventIds } from './writeLeaseTransport';
import { notifyProgressSyncWork } from './progressSyncWake';
import { createLeasedEventId, getEventLeaseStatus, parseLeasedEventId } from './writeLeasePolicy';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';
import { annotationTargetKeyV1, isAnnotationHeadV1, type AnnotationHeadV1 } from './annotationSyncSchema';
import { runWithTimeout } from './readerLoadLifecycle';

const RECONCILE_INTERVAL_MS = 5_000;
const CLEANUP_RECHECK_INTERVAL_MS = 30_000;
const MAX_RECONCILE_BACKOFF_MS = 5 * 60_000;
const lastReconcileByOwner = new Map<OwnerKey, number>();

export type AnnotationBookDeletionIntentV10 = {
  ownerKey: OwnerKey;
  bookId: string;
  createdAt: number;
  lastCheckedAt: number | null;
  failureCount?: number;
  lastErrorCode?: string | null;
  nextRetryAt?: number;
  markerEventId?: string;
  markerRevision?: number;
  markerSuperseded?: boolean;
  writeLeaseEventId?: string;
  writeLeaseDeviceId?: string;
  expired?: boolean;
  recoveryPending?: boolean;
};

export type ObservedAnnotationBookDeletionV5 =
  | { markerRevision: number; nextMarkerSequence: number; awaitingMarker?: never }
  | { markerRevision?: never; nextMarkerSequence?: never; awaitingMarker: true };

export const isPendingAnnotationBookDeletionMarkerV5 = (event: SyncOutboxEventV5 | undefined) => (
  event?.target.kind === 'annotation' && event.target.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID
  && event.operation === 'annotation.delete' && !event.forceDelete
  && event.status !== 'superseded' && event.status !== 'expired'
);

export const captureAnnotationBookDeletionV5 = async (
  ownerKey: OwnerKey,
  bookId: string,
  readRemoteMarker?: () => Promise<AnnotationHeadV1 | null>,
): Promise<ObservedAnnotationBookDeletionV5> => {
  const db = await initDB();
  const tx = db.transaction([V5_REMOTE_HEADS_STORE, V10_ANNOTATION_BOOK_DELETIONS_STORE, V5_OUTBOX_STORE, V5_SYNC_META_STORE]);
  const markerId = ANNOTATION_BOOK_DELETE_MARKER_ID;
  const markerKey = [ownerKey, annotationTargetKeyV1(bookId, markerId)];
  const [cached, intent, markerMeta] = await Promise.all([
    tx.objectStore(V5_REMOTE_HEADS_STORE).get(markerKey),
    tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).get([ownerKey, bookId]) as Promise<AnnotationBookDeletionIntentV10 | undefined>,
    tx.objectStore(V5_SYNC_META_STORE).get(markerKey),
  ]);
  const pendingMarker = intent?.markerEventId && !intent.expired && !intent.markerSuperseded && intent.markerRevision === undefined
    ? await tx.objectStore(V5_OUTBOX_STORE).get([ownerKey, intent.markerEventId]) as SyncOutboxEventV5 | undefined
    : undefined;
  await tx.done;
  // A repeat confirmation belongs to the pending marker even if its ACK or
  // cleanup finishes before the shelf finishes deleting the local book.
  if (isPendingAnnotationBookDeletionMarkerV5(pendingMarker)) {
    return { awaitingMarker: true };
  }
  // This counter survives acknowledgement, intent cleanup, and lease binding.
  // A slow lookup must not move a confirmation past a marker queued by another tab.
  const nextMarkerSequence = markerMeta?.nextSequence ?? 1;
  const head = cached?.head;
  if (isAnnotationHeadV1(head) && head.bookId === bookId && head.annotationId === markerId
    && head.operation === 'delete') return { markerRevision: head.revision, nextMarkerSequence };
  if (!readRemoteMarker) return { markerRevision: 0, nextMarkerSequence };

  try {
    const marker = await runWithTimeout(readRemoteMarker(), 4_000, '원격 주석 삭제 마커 조회 시간 초과');
    if (marker?.bookId === bookId && marker.annotationId === markerId && marker.operation === 'delete') {
      return { markerRevision: marker.revision, nextMarkerSequence };
    }
  } catch (error) {
    console.warn('[AnnotationSync] Could not confirm a deletion marker before book removal:', error);
  }
  // With no observed marker, the server will only accept a first-generation deletion.
  return { markerRevision: 0, nextMarkerSequence };
};

export const annotationBookDeletionNeedsRecovery = (
  intent: AnnotationBookDeletionIntentV10,
  serverTrustedNow: number | null,
  recoverablePendingIds: ReadonlySet<string>,
  pendingMarker?: PendingSyncAuthority,
): boolean => {
  if (intent.markerSuperseded) return false;
  if (intent.expired) return intent.recoveryPending !== false;
  if (serverTrustedNow === null) return false;
  if (!intent.markerEventId || intent.writeLeaseEventId !== intent.markerEventId || !intent.writeLeaseDeviceId) return true;
  const authorityId = pendingMarker?.eventId === intent.markerEventId
    ? getPendingSyncAuthorityId(pendingMarker) : intent.markerEventId;
  if (parseLeasedEventId(intent.writeLeaseEventId)) {
    return getEventLeaseStatus(intent.writeLeaseEventId, serverTrustedNow, true) === 'expired'
      && (authorityId === intent.markerEventId || recoverablePendingIds.has(authorityId));
  }
  return recoverablePendingIds.has(authorityId);
};

// Never overwrite an intent that changed while the server request was in flight.
const updateIntent = async (intent: AnnotationBookDeletionIntentV10, update: Partial<AnnotationBookDeletionIntentV10> | null) => {
  const db = await initDB();
  const tx = db.transaction(V10_ANNOTATION_BOOK_DELETIONS_STORE, 'readwrite');
  const store = tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE);
  const current = await store.get([intent.ownerKey, intent.bookId]) as AnnotationBookDeletionIntentV10 | undefined;
  if (current && JSON.stringify(current) === JSON.stringify(intent)) {
    if (update) await store.put({ ...current, ...update });
    else await store.delete([intent.ownerKey, intent.bookId]);
  }
  await tx.done;
};

const getErrorCode = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code.slice(0, 120);
  }
  return error instanceof Error && error.name ? error.name : 'unknown';
};

const getRetryDelay = (failureCount: number) => Math.min(
  MAX_RECONCILE_BACKOFF_MS,
  RECONCILE_INTERVAL_MS * (2 ** Math.min(failureCount - 1, 6)),
);

type FetchAuthoritativeHeads = (
  uid: string,
  bookId: string,
) => Promise<Awaited<ReturnType<
  typeof import('./annotationSyncRemote')['getAuthoritativeRemoteAnnotationHeadsV1']
>>>;

export const reconcileAnnotationBookDeletionIntentsV10 = async (
  uid: string,
  ownerKey: OwnerKey,
  context: AnnotationSyncContextV5,
  now = Date.now(),
  fetchHeads?: FetchAuthoritativeHeads,
) => {
  const previous = lastReconcileByOwner.get(ownerKey) ?? 0;
  if (now - previous < RECONCILE_INTERVAL_MS) return { intents: 0, queued: 0 };
  lastReconcileByOwner.set(ownerKey, now);
  const db = await initDB();
  const intents = await db.getAllFromIndex(
    V10_ANNOTATION_BOOK_DELETIONS_STORE,
    'by-owner',
    ownerKey,
  ) as AnnotationBookDeletionIntentV10[];
  const finiteLeases = finiteWriteLeasesEnabled();
  const trustedNow = getTrustedWriteLeaseTime(ownerKey);
  const pendingMarkers = new Map<string, SyncOutboxEventV5>();
  let recoverablePendingIds: ReadonlySet<string> = new Set();
  if (finiteLeases && trustedNow !== null) {
    const ids = await Promise.all(intents.flatMap(({ markerEventId, markerSuperseded, expired }) => (
      markerEventId && !markerSuperseded && !expired ? [(async () => {
        const event = await db.get(V5_OUTBOX_STORE, [ownerKey, markerEventId]) as SyncOutboxEventV5 | undefined;
        if (event) pendingMarkers.set(markerEventId, event);
        return event ? getPendingSyncAuthorityId(event) : markerEventId;
      })()] : []
    )));
    recoverablePendingIds = await readRecoverableSyncEventIds(ownerKey, ids);
  }
  let queued = 0;
  let failed = 0;
  const fetchAuthoritativeHeads = fetchHeads ?? (await import('./annotationSyncRemote'))
    .getAuthoritativeRemoteAnnotationHeadsV1;
  for (const intent of intents) {
    if (intent.expired || intent.markerSuperseded) continue;
    if (!intent.markerEventId) {
      if (!finiteLeases || trustedNow !== null) {
        await updateIntent(intent, { expired: true, recoveryPending: true, lastErrorCode: 'sync/annotation-delete-unproven' });
      }
      continue;
    }
    if (finiteLeases && annotationBookDeletionNeedsRecovery(intent, trustedNow, recoverablePendingIds, pendingMarkers.get(intent.markerEventId))) {
      await updateIntent(intent, { expired: true, recoveryPending: true, lastErrorCode: 'sync/write-lease-expired' });
      continue;
    }
    const lease = parseLeasedEventId(intent.markerEventId);
    if (finiteLeases && (!lease || intent.writeLeaseDeviceId !== context.deviceId
      || trustedNow === null || getEventLeaseStatus(intent.markerEventId, trustedNow, true) !== 'valid')) continue;
    const boundary = intent.markerRevision;
    if (boundary === undefined) {
      // An older tab can acknowledge the marker without persisting its receipt revision.
      const markerEvent = await db.get(V5_OUTBOX_STORE, [ownerKey, intent.markerEventId]) as SyncOutboxEventV5 | undefined;
      if (!markerEvent || markerEvent.status === 'superseded') {
        await updateIntent(intent, { markerSuperseded: true, lastErrorCode: 'sync/annotation-delete-unproven' });
      }
      continue;
    }
    if (!Number.isSafeInteger(boundary) || boundary < 1) continue;
    if ((intent.nextRetryAt ?? 0) > now) continue;
    try {
      const sinceLastCheck = intent.lastCheckedAt === null ? Infinity : now - intent.lastCheckedAt;
      if (sinceLastCheck >= 0 && sinceLastCheck < CLEANUP_RECHECK_INTERVAL_MS) {
        const [ready, inFlight] = await Promise.all([
          db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status-next-attempt', IDBKeyRange.bound(
            [ownerKey, 'pending', 0], [ownerKey, 'pending', now],
          )) as Promise<SyncOutboxEventV5[]>,
          db.getAllFromIndex(V5_OUTBOX_STORE, 'by-owner-status', [ownerKey, 'in_flight']) as Promise<SyncOutboxEventV5[]>,
        ]);
        // Give queued deletes time to drain, with a bounded recheck if another
        // target still needs discovery or a worker stops making progress.
        const isCurrentCleanup = (event: SyncOutboxEventV5) => isAnnotationOutboxEventV5(event)
          && event.target.bookId === intent.bookId && event.deleteBeforeBookGeneration === boundary;
        if (ready.some(isCurrentCleanup) || inFlight.some(isCurrentCleanup)) continue;
      }
      const heads = await fetchAuthoritativeHeads(uid, intent.bookId);
      const historicalHeads = heads.filter((head) => (head.bookGeneration ?? 0) < boundary);
      if (historicalHeads.length === 0) {
        await updateIntent(intent, null);
        continue;
      }
      const tx = db.transaction([V10_ANNOTATION_BOOK_DELETIONS_STORE, V5_OUTBOX_STORE, V5_SYNC_META_STORE,
        V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE], 'readwrite');
      void tx.done.catch(() => undefined);
      const current = await tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).get([ownerKey, intent.bookId]);
      const currentTrustedNow = getTrustedWriteLeaseTime(ownerKey);
      if (JSON.stringify(current) !== JSON.stringify(intent)
        || (finiteLeases && (currentTrustedNow === null
          || getEventLeaseStatus(intent.markerEventId, currentTrustedNow, true) !== 'valid'))) {
        await tx.done;
        continue;
      }
      const created = await appendAnnotationEventsToTransactionV5(tx, ownerKey, historicalHeads.map((head) => ({
        ...(finiteLeases && lease ? { eventId: createLeasedEventId({ ...lease, deviceId: context.deviceId }) } : {}),
        bookId: intent.bookId,
        annotationId: head.annotationId,
        operation: 'annotation.delete' as const,
        payload: null,
        baseRevision: head.revision,
        deleteBeforeBookGeneration: boundary,
        occurredAtClient: now,
      })), context);
      await tx.done;
      queued += created.length;
      if (created.length) notifyProgressSyncWork(ownerKey);
      await updateIntent(intent, {
        lastCheckedAt: now,
        failureCount: 0,
        lastErrorCode: null,
        nextRetryAt: 0,
      });
    } catch (error) {
      failed += 1;
      const failureCount = (intent.failureCount ?? 0) + 1;
      await updateIntent(intent, {
        lastCheckedAt: now,
        failureCount,
        lastErrorCode: getErrorCode(error),
        nextRetryAt: now + getRetryDelay(failureCount),
      });
    }
  }
  return { intents: intents.length, queued, failed };
};
