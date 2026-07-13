import { doc, runTransaction, serverTimestamp, type Firestore } from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import {
  bookmarkTargetKeyV2,
  getFirebaseSyncHistoryPath,
  isBookmarkHeadV2,
  isEventReceiptV2,
  type BookmarkHeadV2,
  type EventReceiptV2,
} from './progressV2Schema';
import type { BookmarkOutboxEventV5 } from './syncOutboxV5';

export type BookmarkTransactionDecision =
  | { status: 'apply'; head: BookmarkHeadV2; receipt: EventReceiptV2 }
  | { status: 'already_applied'; head: BookmarkHeadV2; receipt: EventReceiptV2 }
  | { status: 'conflict'; remoteHead: BookmarkHeadV2 | null };

type BookmarkFirestoreSDK = {
  doc: typeof doc;
  runTransaction: typeof runTransaction;
  serverTimestamp: typeof serverTimestamp;
};

const defaultFirestoreSDK: BookmarkFirestoreSDK = { doc, runTransaction, serverTimestamp };

export const decideBookmarkTransaction = ({
  event,
  storedHead,
  storedReceipt,
  serverTime,
}: {
  event: BookmarkOutboxEventV5;
  storedHead: unknown;
  storedReceipt: unknown;
  serverTime: unknown;
}): BookmarkTransactionDecision => {
  if (storedReceipt !== undefined) {
    if (!isEventReceiptV2(storedReceipt) || !isBookmarkHeadV2(storedHead)) {
      throw new Error('bookmark receipt와 head가 일치하지 않습니다.');
    }
    if (
      storedReceipt.eventId !== event.eventId
      || storedReceipt.targetKey !== event.targetKey
      || storedReceipt.targetKind !== 'bookmark'
      || storedReceipt.bookId !== event.target.bookId
      || storedReceipt.bookmarkId !== event.target.bookmarkId
      || storedHead.bookId !== event.target.bookId
      || storedHead.bookmarkId !== event.target.bookmarkId
      || storedHead.revision < storedReceipt.revision
    ) throw new Error('bookmark receipt가 요청 event와 일치하지 않습니다.');
    return { status: 'already_applied', head: storedHead, receipt: storedReceipt };
  }
  const remoteHead = storedHead === undefined
    ? null
    : isBookmarkHeadV2(storedHead)
      ? storedHead
      : (() => { throw new Error('원격 bookmark head schema가 올바르지 않습니다.'); })();
  if ((remoteHead?.revision ?? 0) !== event.baseRevision) {
    return { status: 'conflict', remoteHead };
  }
  const revision = (remoteHead?.revision ?? 0) + 1;
  const deleting = event.operation === 'bookmark.delete';
  const head: BookmarkHeadV2 = {
    schemaVersion: 2,
    bookId: event.target.bookId,
    bookmarkId: event.target.bookmarkId,
    revision,
    acceptedEventId: event.eventId,
    operation: deleting ? 'delete' : 'upsert',
    bookmark: deleting ? null : event.payload,
    acceptedDeviceId: event.deviceId,
    acceptedSessionId: event.sessionId,
    occurredAtClient: event.occurredAtClient,
    updatedAtServer: serverTime,
    deletedAtServer: deleting ? serverTime : null,
  };
  const receipt: EventReceiptV2 = {
    schemaVersion: 2,
    eventId: event.eventId,
    targetKind: 'bookmark',
    bookId: event.target.bookId,
    bookmarkId: event.target.bookmarkId,
    targetKey: bookmarkTargetKeyV2(event.target.bookId, event.target.bookmarkId),
    revision,
    createdAtServer: serverTime,
  };
  return { status: 'apply', head, receipt };
};

export const applyBookmarkEventTransaction = async ({
  event,
  uid,
  firestore,
  sdk = defaultFirestoreSDK,
}: {
  event: BookmarkOutboxEventV5;
  uid: string;
  firestore: Firestore;
  sdk?: BookmarkFirestoreSDK;
}) => {
  const historyPath = getFirebaseSyncHistoryPath(APP_ID, uid);
  const bookRef = sdk.doc(firestore, historyPath, event.target.bookId);
  const bookmarkRef = sdk.doc(bookRef, 'bookmarks', event.target.bookmarkId);
  const receiptRef = sdk.doc(bookRef, 'eventReceipts', event.eventId);
  return sdk.runTransaction(firestore, async (transaction) => {
    const [receiptSnapshot, bookmarkSnapshot] = await Promise.all([
      transaction.get(receiptRef),
      transaction.get(bookmarkRef),
    ]);
    const decision = decideBookmarkTransaction({
      event,
      storedHead: bookmarkSnapshot.exists() ? bookmarkSnapshot.data() : undefined,
      storedReceipt: receiptSnapshot.exists() ? receiptSnapshot.data() : undefined,
      serverTime: sdk.serverTimestamp(),
    });
    if (decision.status !== 'apply') return decision;
    transaction.set(bookmarkRef, decision.head);
    transaction.set(receiptRef, decision.receipt);
    return decision;
  });
};
