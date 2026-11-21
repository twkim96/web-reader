import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_REMOTE_HEADS_STORE,
  V5_OUTBOX_STORE, V5_SYNC_META_STORE, V5_SYNC_CONFLICTS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import {
  appendAnnotationEventsToTransactionV5,
  type AnnotationSyncContextV5,
  type SyncOutboxEventV5,
} from './syncOutboxV5';
import { finiteWriteLeasesEnabled, getTrustedWriteLeaseTime, readRecoverableSyncEventIds } from './writeLeaseTransport';
import { notifyProgressSyncWork } from './progressSyncWake';
import { createLeasedEventId, getEventLeaseStatus, parseLeasedEventId } from './writeLeasePolicy';

const RECONCILE_INTERVAL_MS = 5_000;
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

export const annotationBookDeletionNeedsRecovery = (
  intent: AnnotationBookDeletionIntentV10,
  serverTrustedNow: number | null,
  recoverablePendingIds: ReadonlySet<string>,
): boolean => {
  if (intent.markerSuperseded) return false;
  if (intent.expired) return intent.recoveryPending !== false;
  if (serverTrustedNow === null) return false;
  if (!intent.markerEventId || intent.writeLeaseEventId !== intent.markerEventId || !intent.writeLeaseDeviceId) return true;
  if (parseLeasedEventId(intent.writeLeaseEventId)) {
    return getEventLeaseStatus(intent.writeLeaseEventId, serverTrustedNow, true) === 'expired';
  }
  return recoverablePendingIds.has(intent.markerEventId);
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
  const recoverablePendingIds = finiteLeases && trustedNow !== null
    ? await readRecoverableSyncEventIds(ownerKey, intents.flatMap(({ markerEventId, markerSuperseded, expired }) => (
      markerEventId && !markerSuperseded && !expired ? [markerEventId] : []
    )))
    : new Set<string>();
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
    if (finiteLeases && annotationBookDeletionNeedsRecovery(intent, trustedNow, recoverablePendingIds)) {
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
