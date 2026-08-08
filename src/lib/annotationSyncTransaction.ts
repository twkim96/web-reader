import {
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import {
  annotationPaletteTargetKeyV1,
  annotationTargetKeyV1,
  getFirebaseAnnotationBookAggregatePath,
  getFirebaseAnnotationPalettePath,
  getFirebaseAnnotationSyncPath,
  isAnnotationHeadV1,
  isAnnotationBookAggregateV1,
  isAnnotationPaletteHeadV1,
  isAnnotationPalettePayloadV1,
  isAnnotationSyncPayloadV1,
  isAnnotationSyncReceiptV1,
  type AnnotationHeadV1,
  type AnnotationAggregateConflictReasonV1,
  type AnnotationBookAggregateV1,
  type AnnotationPaletteHeadV1,
  type AnnotationPaletteSyncMutationV1,
  type AnnotationSyncMutationV1,
  type AnnotationSyncReceiptV1,
} from './annotationSyncSchema';

export type AnnotationTransactionDecision =
  | { status: 'apply'; head: AnnotationHeadV1; receipt: AnnotationSyncReceiptV1; aggregate: AnnotationBookAggregateV1 }
  | { status: 'already_applied'; head: AnnotationHeadV1; receipt: AnnotationSyncReceiptV1; aggregate: AnnotationBookAggregateV1 }
  | {
    status: 'conflict';
    remoteHead: AnnotationHeadV1 | null;
    conflictReason?: AnnotationAggregateConflictReasonV1;
  };

export type AnnotationPaletteTransactionDecision =
  | { status: 'apply'; head: AnnotationPaletteHeadV1; receipt: AnnotationSyncReceiptV1 }
  | { status: 'already_applied'; head: AnnotationPaletteHeadV1; receipt: AnnotationSyncReceiptV1 }
  | { status: 'conflict'; remoteHead: AnnotationPaletteHeadV1 | null };

type AnnotationFirestoreSDK = {
  doc: typeof doc;
  runTransaction: typeof runTransaction;
  serverTimestamp: typeof serverTimestamp;
};

const defaultFirestoreSDK: AnnotationFirestoreSDK = { doc, runTransaction, serverTimestamp };

const requireValidMutationIdentity = (
  event: AnnotationSyncMutationV1 | AnnotationPaletteSyncMutationV1,
) => {
  if (
    event.eventId.length === 0
    || event.eventId.length > 128
    || event.deviceId.length === 0
    || event.deviceId.length > 128
    || event.sessionId.length === 0
    || event.sessionId.length > 128
    || !Number.isSafeInteger(event.baseRevision)
    || event.baseRevision < 0
    || !Number.isSafeInteger(event.occurredAtClient)
    || event.occurredAtClient < 0
  ) throw new Error('annotation sync event 식별자가 올바르지 않습니다.');
};

export const decideAnnotationTransaction = ({
  event,
  storedHead,
  storedReceipt,
  storedAggregate,
  serverTime,
}: {
  event: AnnotationSyncMutationV1;
  storedHead: unknown;
  storedReceipt: unknown;
  storedAggregate: unknown;
  serverTime: unknown;
}): AnnotationTransactionDecision => {
  requireValidMutationIdentity(event);
  const expectedTargetKey = annotationTargetKeyV1(
    event.target.bookId,
    event.target.annotationId,
  );
  if (event.targetKey !== expectedTargetKey) {
    throw new Error('annotation sync target key가 올바르지 않습니다.');
  }
  const deleting = event.operation === 'annotation.delete';
  if (
    deleting
      ? event.payload !== null
      : !isAnnotationSyncPayloadV1(event.payload)
        || event.payload.id !== event.target.annotationId
        || event.payload.bookId !== event.target.bookId
  ) throw new Error('annotation sync payload가 올바르지 않습니다.');

  if (storedReceipt !== undefined) {
    if (
      !isAnnotationSyncReceiptV1(storedReceipt)
      || !isAnnotationHeadV1(storedHead)
      || !isAnnotationBookAggregateV1(storedAggregate)
    ) {
      throw new Error('annotation receipt와 head가 일치하지 않습니다.');
    }
    if (
      storedReceipt.eventId !== event.eventId
      || storedReceipt.targetKind !== 'annotation'
      || storedReceipt.bookId !== event.target.bookId
      || storedReceipt.annotationId !== event.target.annotationId
      || storedReceipt.targetKey !== event.targetKey
      || storedHead.bookId !== event.target.bookId
      || storedHead.annotationId !== event.target.annotationId
      || storedHead.revision < storedReceipt.revision
    ) throw new Error('annotation receipt가 요청 event와 일치하지 않습니다.');
    return {
      status: 'already_applied',
      head: storedHead,
      receipt: storedReceipt,
      aggregate: storedAggregate,
    };
  }

  const remoteHead = storedHead === undefined
    ? null
    : isAnnotationHeadV1(storedHead)
      ? storedHead
      : (() => { throw new Error('원격 annotation head schema가 올바르지 않습니다.'); })();
  const remoteRevision = remoteHead?.revision ?? 0;
  if (
    remoteRevision !== event.baseRevision
    && !(deleting && event.forceDelete === true)
  ) return { status: 'conflict', remoteHead };
  const aggregate = storedAggregate === undefined
    ? null
    : isAnnotationBookAggregateV1(storedAggregate)
      ? storedAggregate
      : (() => { throw new Error('원격 annotation aggregate schema가 올바르지 않습니다.'); })();
  if (remoteHead && !aggregate) {
    throw new Error('원격 annotation head에 aggregate가 없습니다.');
  }

  const entries = { ...(aggregate?.entries ?? {}) };
  const rangeCfis = [...(aggregate?.rangeCfis ?? [])];
  const colorCounts = {
    yellow: aggregate?.colorCounts.yellow ?? 0,
    green: aggregate?.colorCounts.green ?? 0,
    blue: aggregate?.colorCounts.blue ?? 0,
    pink: aggregate?.colorCounts.pink ?? 0,
    purple: aggregate?.colorCounts.purple ?? 0,
  };
  const previousEntry = entries[event.target.annotationId];
  if (previousEntry) {
    const previousRangeIndex = rangeCfis.indexOf(previousEntry.rangeCfi);
    if (previousRangeIndex >= 0) rangeCfis.splice(previousRangeIndex, 1);
    colorCounts[previousEntry.colorId] -= 1;
    delete entries[event.target.annotationId];
  }
  if (!deleting) {
    const payload = event.payload!;
    if (rangeCfis.includes(payload.rangeCfi)) {
      return {
        status: 'conflict',
        remoteHead,
        conflictReason: 'annotation-duplicate-range',
      };
    }
    if (Object.keys(entries).length >= 100) {
      return {
        status: 'conflict',
        remoteHead,
        conflictReason: 'annotation-book-limit',
      };
    }
    if (colorCounts[payload.colorId] >= 20) {
      return {
        status: 'conflict',
        remoteHead,
        conflictReason: 'annotation-color-limit',
      };
    }
    entries[event.target.annotationId] = {
      rangeCfi: payload.rangeCfi,
      colorId: payload.colorId,
    };
    rangeCfis.push(payload.rangeCfi);
    colorCounts[payload.colorId] += 1;
  }

  const revision = remoteRevision + 1;
  const head: AnnotationHeadV1 = {
    schemaVersion: 1,
    bookId: event.target.bookId,
    annotationId: event.target.annotationId,
    revision,
    acceptedEventId: event.eventId,
    operation: deleting ? 'delete' : 'upsert',
    annotation: deleting ? null : event.payload,
    acceptedDeviceId: event.deviceId,
    acceptedSessionId: event.sessionId,
    occurredAtClient: event.occurredAtClient,
    updatedAtServer: serverTime,
    deletedAtServer: deleting ? serverTime : null,
  };
  const receipt: AnnotationSyncReceiptV1 = {
    schemaVersion: 1,
    eventId: event.eventId,
    targetKind: 'annotation',
    bookId: event.target.bookId,
    annotationId: event.target.annotationId,
    targetKey: expectedTargetKey,
    revision,
    createdAtServer: serverTime,
  };
  const nextAggregate: AnnotationBookAggregateV1 = {
    schemaVersion: 1,
    bookId: event.target.bookId,
    revision: (aggregate?.revision ?? 0) + 1,
    totalCount: Object.keys(entries).length,
    colorCounts,
    entries,
    rangeCfis,
    acceptedEventId: event.eventId,
    acceptedAnnotationId: event.target.annotationId,
    acceptedOperation: deleting ? 'delete' : 'upsert',
    updatedAtServer: serverTime,
  };
  if (!isAnnotationBookAggregateV1(nextAggregate)) {
    throw new Error('annotation aggregate 계산 결과가 올바르지 않습니다.');
  }
  return { status: 'apply', head, receipt, aggregate: nextAggregate };
};

export const decideAnnotationPaletteTransaction = ({
  event,
  storedHead,
  storedReceipt,
  serverTime,
}: {
  event: AnnotationPaletteSyncMutationV1;
  storedHead: unknown;
  storedReceipt: unknown;
  serverTime: unknown;
}): AnnotationPaletteTransactionDecision => {
  requireValidMutationIdentity(event);
  const expectedTargetKey = annotationPaletteTargetKeyV1();
  if (
    event.targetKey !== expectedTargetKey
    || event.operation !== 'palette.set'
    || !isAnnotationPalettePayloadV1(event.payload)
  ) throw new Error('annotation palette sync payload가 올바르지 않습니다.');

  if (storedReceipt !== undefined) {
    if (
      !isAnnotationSyncReceiptV1(storedReceipt)
      || !isAnnotationPaletteHeadV1(storedHead)
    ) throw new Error('annotation palette receipt와 head가 일치하지 않습니다.');
    if (
      storedReceipt.eventId !== event.eventId
      || storedReceipt.targetKind !== 'palette'
      || storedReceipt.bookId !== null
      || storedReceipt.annotationId !== null
      || storedReceipt.targetKey !== event.targetKey
      || storedHead.revision < storedReceipt.revision
    ) throw new Error('annotation palette receipt가 요청 event와 일치하지 않습니다.');
    return { status: 'already_applied', head: storedHead, receipt: storedReceipt };
  }

  const remoteHead = storedHead === undefined
    ? null
    : isAnnotationPaletteHeadV1(storedHead)
      ? storedHead
      : (() => { throw new Error('원격 annotation palette schema가 올바르지 않습니다.'); })();
  const remoteRevision = remoteHead?.revision ?? 0;
  if (remoteRevision !== event.baseRevision) return { status: 'conflict', remoteHead };

  const revision = remoteRevision + 1;
  const head: AnnotationPaletteHeadV1 = {
    schemaVersion: 1,
    revision,
    acceptedEventId: event.eventId,
    operation: 'set',
    palette: event.payload,
    acceptedDeviceId: event.deviceId,
    acceptedSessionId: event.sessionId,
    occurredAtClient: event.occurredAtClient,
    updatedAtServer: serverTime,
  };
  const receipt: AnnotationSyncReceiptV1 = {
    schemaVersion: 1,
    eventId: event.eventId,
    targetKind: 'palette',
    bookId: null,
    annotationId: null,
    targetKey: expectedTargetKey,
    revision,
    createdAtServer: serverTime,
  };
  return { status: 'apply', head, receipt };
};

export const applyAnnotationEventTransaction = async ({
  event,
  uid,
  firestore,
  sdk = defaultFirestoreSDK,
}: {
  event: AnnotationSyncMutationV1;
  uid: string;
  firestore: Firestore;
  sdk?: AnnotationFirestoreSDK;
}) => {
  const basePath = getFirebaseAnnotationSyncPath(APP_ID, uid);
  const headRef = sdk.doc(
    firestore,
    `${basePath}/${event.target.bookId}/annotations/${event.target.annotationId}`,
  );
  const receiptRef = sdk.doc(
    firestore,
    `${basePath}/${event.target.bookId}/eventReceipts/${event.eventId}`,
  );
  const aggregateRef = sdk.doc(
    firestore,
    getFirebaseAnnotationBookAggregatePath(APP_ID, uid, event.target.bookId),
  );
  return sdk.runTransaction(firestore, async (transaction) => {
    const [receiptSnapshot, headSnapshot, aggregateSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(headRef),
      transaction.get(aggregateRef),
    ]);
    const decision = decideAnnotationTransaction({
      event,
      storedHead: headSnapshot.exists() ? headSnapshot.data() : undefined,
      storedReceipt: receiptSnapshot.exists() ? receiptSnapshot.data() : undefined,
      storedAggregate: aggregateSnapshot.exists() ? aggregateSnapshot.data() : undefined,
      serverTime: sdk.serverTimestamp(),
    });
    if (decision.status !== 'apply') return decision;
    transaction.set(headRef, decision.head);
    transaction.set(receiptRef, decision.receipt);
    transaction.set(aggregateRef, decision.aggregate);
    return decision;
  });
};

export const applyAnnotationPaletteEventTransaction = async ({
  event,
  uid,
  firestore,
  sdk = defaultFirestoreSDK,
}: {
  event: AnnotationPaletteSyncMutationV1;
  uid: string;
  firestore: Firestore;
  sdk?: AnnotationFirestoreSDK;
}) => {
  const headPath = getFirebaseAnnotationPalettePath(APP_ID, uid);
  const headRef = sdk.doc(firestore, headPath);
  const receiptRef = sdk.doc(headRef, 'eventReceipts', event.eventId);
  return sdk.runTransaction(firestore, async (transaction) => {
    const [receiptSnapshot, headSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(headRef),
    ]);
    const decision = decideAnnotationPaletteTransaction({
      event,
      storedHead: headSnapshot.exists() ? headSnapshot.data() : undefined,
      storedReceipt: receiptSnapshot.exists() ? receiptSnapshot.data() : undefined,
      serverTime: sdk.serverTimestamp(),
    });
    if (decision.status !== 'apply') return decision;
    transaction.set(headRef, decision.head);
    transaction.set(receiptRef, decision.receipt);
    return decision;
  });
};
