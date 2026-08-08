import type { OwnerKey } from './ownerIdentity';
import { initDB } from './localDB';
import {
  V5_REMOTE_HEADS_STORE,
  V10_ANNOTATION_BOOK_DELETIONS_STORE,
} from './localDBSchema';
import {
  enqueueAnnotationEventsV5,
  hasActiveSyncTargetWorkV5,
  type RemoteHeadCacheV5,
  type AnnotationSyncContextV5,
} from './syncOutboxV5';
import {
  annotationTargetKeyV1,
  isAnnotationHeadV1,
} from './annotationSyncSchema';
import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';

const RECONCILE_INTERVAL_MS = 5_000;
const lastReconcileByOwner = new Map<OwnerKey, number>();

export type AnnotationBookDeletionIntentV10 = {
  ownerKey: OwnerKey;
  bookId: string;
  createdAt: number;
  lastCheckedAt: number | null;
};

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
  let queued = 0;
  const fetchAuthoritativeHeads = fetchHeads ?? (await import('./annotationSyncRemote'))
    .getAuthoritativeRemoteAnnotationHeadsV1;
  for (const intent of intents) {
    const heads = await fetchAuthoritativeHeads(uid, intent.bookId);
    const inputs = [];
    for (const head of heads) {
      const targetKey = annotationTargetKeyV1(intent.bookId, head.annotationId);
      if (await hasActiveSyncTargetWorkV5(ownerKey, targetKey)) continue;
      inputs.push({
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
      queued += (await enqueueAnnotationEventsV5(ownerKey, inputs, context)).length;
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
      && markerHead.operation === 'delete'
      && markerHead.occurredAtClient >= intent.createdAt;
    const markerStillActive = await hasActiveSyncTargetWorkV5(ownerKey, markerTargetKey);
    if (heads.length === 0 && markerCommitted && !markerStillActive) {
      await db.delete(V10_ANNOTATION_BOOK_DELETIONS_STORE, [ownerKey, intent.bookId]);
    } else {
      await db.put(V10_ANNOTATION_BOOK_DELETIONS_STORE, {
        ...intent,
        lastCheckedAt: now,
      } satisfies AnnotationBookDeletionIntentV10);
    }
  }
  return { intents: intents.length, queued };
};
