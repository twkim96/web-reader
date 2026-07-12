import {
  doc,
  runTransaction,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import type { LibraryScopeKey } from './ownerIdentity';
import {
  getV2HistoryPath,
  isEventReceiptV2,
  isProgressHeadV2,
  progressTargetKeyV2,
  type EventReceiptV2,
  type ProgressHeadV2,
} from './progressV2Schema';
import type { ProgressOutboxEventV5 } from './syncOutboxV5';

export type ProgressTransactionDecision =
  | { status: 'apply'; head: ProgressHeadV2; receipt: EventReceiptV2 }
  | { status: 'already_applied'; head: ProgressHeadV2; receipt: EventReceiptV2 }
  | { status: 'conflict'; remoteHead: ProgressHeadV2 | null };

export const decideProgressTransaction = ({
  event,
  storedHead,
  storedReceipt,
  serverTime,
}: {
  event: ProgressOutboxEventV5;
  storedHead: unknown;
  storedReceipt: unknown;
  serverTime: unknown;
}): ProgressTransactionDecision => {
  if (storedReceipt !== undefined) {
    if (!isEventReceiptV2(storedReceipt) || !isProgressHeadV2(storedHead)) {
      throw new Error('event receipt와 progress head가 일치하지 않습니다.');
    }
    if (
      storedReceipt.eventId !== event.eventId
      || storedReceipt.targetKey !== event.targetKey
      || storedReceipt.revision !== storedHead.revision
      || storedHead.acceptedEventId !== event.eventId
    ) {
      throw new Error('event receipt가 요청 event와 일치하지 않습니다.');
    }
    return { status: 'already_applied', head: storedHead, receipt: storedReceipt };
  }

  const remoteHead = storedHead === undefined
    ? null
    : isProgressHeadV2(storedHead)
      ? storedHead
      : (() => { throw new Error('원격 progress head schema가 올바르지 않습니다.'); })();
  const remoteRevision = remoteHead?.revision ?? 0;
  if (remoteRevision !== event.baseRevision) {
    return { status: 'conflict', remoteHead };
  }

  const revision = remoteRevision + 1;
  const isReset = event.operation === 'progress.reset';
  const head: ProgressHeadV2 = {
    schemaVersion: 2,
    bookId: event.target.bookId,
    revision,
    acceptedEventId: event.eventId,
    operation: isReset ? 'reset' : 'set',
    position: isReset ? null : event.payload,
    acceptedDeviceId: event.deviceId,
    occurredAtClient: event.occurredAtClient,
    updatedAtServer: serverTime,
    deletedAtServer: isReset ? serverTime : null,
  };
  const receipt: EventReceiptV2 = {
    schemaVersion: 2,
    eventId: event.eventId,
    targetKind: 'progress',
    bookId: event.target.bookId,
    bookmarkId: null,
    targetKey: progressTargetKeyV2(event.target.bookId),
    revision,
    createdAtServer: serverTime,
  };
  return { status: 'apply', head, receipt };
};

export const applyProgressEventTransaction = async ({
  event,
  uid,
  libraryScopeKey,
  firestore,
}: {
  event: ProgressOutboxEventV5;
  uid: string;
  libraryScopeKey: LibraryScopeKey;
  firestore: Firestore;
}) => {
  const historyPath = getV2HistoryPath(APP_ID, uid, libraryScopeKey);
  const headRef = doc(firestore, historyPath, event.target.bookId);
  const receiptRef = doc(headRef, 'eventReceipts', event.eventId);

  return runTransaction(firestore, async (transaction) => {
    const [receiptSnapshot, headSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(headRef),
    ]);
    const decision = decideProgressTransaction({
      event,
      storedHead: headSnapshot.exists() ? headSnapshot.data() : undefined,
      storedReceipt: receiptSnapshot.exists() ? receiptSnapshot.data() : undefined,
      serverTime: serverTimestamp(),
    });
    if (decision.status !== 'apply') return decision;
    transaction.set(headRef, decision.head);
    transaction.set(receiptRef, decision.receipt);
    return decision;
  });
};
