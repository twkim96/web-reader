import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_REMOTE_HEADS_STORE,
  V5_OUTBOX_STORE, V5_SYNC_META_STORE, V5_SYNC_CONFLICTS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import {
  appendAnnotationEventsToTransactionV5,
  hasActiveSyncTargetWorkV5,
  type RemoteHeadCacheV5,
  type AnnotationSyncContextV5,
  type SyncOutboxEventV5,
} from './syncOutboxV5';
import {
  annotationTargetKeyV1,
  isAnnotationHeadV1,
} from './annotationSyncSchema';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';
import { finiteWriteLeasesEnabled, getTrustedWriteLeaseTime, isPendingSyncEventId } from './writeLeaseTransport';
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
  writeLeaseEventId?: string;
  writeLeaseDeviceId?: string;
  expired?: boolean;
  recoveryPending?: boolean;
};

export const annotationBookDeletionNeedsRecovery = (
  intent: AnnotationBookDeletionIntentV10,
  serverTrustedNow: number | null,
  bookEvents: ReadonlyArray<Pick<SyncOutboxEventV5, 'ownerKey' | 'target' | 'attempts' | 'claimToken' | 'claimedByTabId' | 'claimedLeaseEpoch'>> = [],
): boolean => {
  if (intent.expired) return intent.recoveryPending !== false;
  if (serverTrustedNow === null) return false;
  if (!intent.writeLeaseEventId || !intent.writeLeaseDeviceId) return true;
  if (parseLeasedEventId(intent.writeLeaseEventId)) {
    return getEventLeaseStatus(intent.writeLeaseEventId, serverTrustedNow, true) === 'expired';
  }
  // Only a never-submitted intent created by this runtime may wait for binding.
  return !isPendingSyncEventId(intent.ownerKey, intent.writeLeaseEventId, intent.writeLeaseDeviceId)
    || bookEvents.some((event) => event.ownerKey === intent.ownerKey
      && 'bookId' in event.target && event.target.bookId === intent.bookId
      && (event.attempts > 0 || event.claimToken !== null || event.claimedByTabId !== null || event.claimedLeaseEpoch !== null));
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
  const bookEvents = finiteWriteLeasesEnabled()
    ? await db.getAll(V5_OUTBOX_STORE) as SyncOutboxEventV5[] : [];
  let queued = 0;
  let failed = 0;
  const fetchAuthoritativeHeads = fetchHeads ?? (await import('./annotationSyncRemote'))
    .getAuthoritativeRemoteAnnotationHeadsV1;
  for (const intent of intents) {
    if (intent.expired) continue;
    if (finiteWriteLeasesEnabled()) {
      const trustedNow = getTrustedWriteLeaseTime(ownerKey);
      if (annotationBookDeletionNeedsRecovery(intent, trustedNow, bookEvents)) {
        await updateIntent(intent, { expired: true, recoveryPending: true, lastErrorCode: 'sync/write-lease-expired' });
        continue;
      }
      if (!intent.writeLeaseEventId || intent.writeLeaseDeviceId !== context.deviceId || trustedNow === null) continue;
      const leaseStatus = getEventLeaseStatus(intent.writeLeaseEventId, trustedNow, true);
      if (leaseStatus === 'expired') await updateIntent(intent, { expired: true, recoveryPending: true, lastErrorCode: 'sync/write-lease-expired' });
      if (leaseStatus !== 'valid') continue;
    }
    if ((intent.nextRetryAt ?? 0) > now) continue;
    try {
      const heads = await fetchAuthoritativeHeads(uid, intent.bookId);
      const inputs = [];
      for (const head of heads) {
        const targetKey = annotationTargetKeyV1(intent.bookId, head.annotationId);
        if (await hasActiveSyncTargetWorkV5(ownerKey, targetKey)) continue;
        inputs.push({
          ...(finiteWriteLeasesEnabled() && intent.writeLeaseEventId
            ? { eventId: createLeasedEventId({ ...parseLeasedEventId(intent.writeLeaseEventId)!, deviceId: context.deviceId }) }
            : {}),
          bookId: intent.bookId,
          annotationId: head.annotationId,
          operation: 'annotation.delete' as const,
          payload: null,
          baseRevision: head.revision,
          forceDelete: true,
          occurredAtClient: now + inputs.length,
        });
      }
      if (inputs.length > 0) {
        const tx = db.transaction([V10_ANNOTATION_BOOK_DELETIONS_STORE, V5_OUTBOX_STORE, V5_SYNC_META_STORE,
          V5_SYNC_CONFLICTS_STORE, V5_REMOTE_HEADS_STORE], 'readwrite');
        void tx.done.catch(() => undefined);
        const current = await tx.objectStore(V10_ANNOTATION_BOOK_DELETIONS_STORE).get([ownerKey, intent.bookId]);
        if (JSON.stringify(current) !== JSON.stringify(intent)) { await tx.done; continue; }
        const trustedNow = getTrustedWriteLeaseTime(ownerKey);
        if (finiteWriteLeasesEnabled() && (!intent.writeLeaseEventId || intent.writeLeaseDeviceId !== context.deviceId
          || trustedNow === null || getEventLeaseStatus(intent.writeLeaseEventId, trustedNow, true) !== 'valid')) {
          await tx.done; continue;
        }
        const created = await appendAnnotationEventsToTransactionV5(tx, ownerKey, inputs, context);
        await tx.done;
        queued += created.length;
        if (created.length) notifyProgressSyncWork(ownerKey);
      }
      const markerTargetKey = annotationTargetKeyV1(
        intent.bookId,
        ANNOTATION_BOOK_DELETE_MARKER_ID,
      );
      const markerCache = await db.get(
        V5_REMOTE_HEADS_STORE,
        [ownerKey, markerTargetKey],
      ) as RemoteHeadCacheV5 | undefined;
      const markerHead = markerCache?.head;
      const markerCommitted = isAnnotationHeadV1(markerHead)
        && markerHead.bookId === intent.bookId
        && markerHead.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID
        && markerHead.operation === 'delete';
      const markerStillActive = await hasActiveSyncTargetWorkV5(ownerKey, markerTargetKey);
      if (heads.length === 0 && markerCommitted && !markerStillActive) {
        await updateIntent(intent, null);
        continue;
      }
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
