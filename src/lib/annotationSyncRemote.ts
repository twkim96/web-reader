import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import { db } from './firebase';
import {
  getFirebaseAnnotationBookAggregatePath,
  getFirebaseAnnotationSyncPath,
  isAnnotationBookAggregateV1,
  parseAnnotationHeadV1,
} from './annotationSyncSchema';

export const getAuthoritativeRemoteAnnotationHeadsV1 = async (
  uid: string,
  bookId: string,
) => {
  const basePath = getFirebaseAnnotationSyncPath(APP_ID, uid);
  const [aggregateSnapshot, headsSnapshot] = await Promise.all([
    getDocFromServer(doc(
      db,
      getFirebaseAnnotationBookAggregatePath(APP_ID, uid, bookId),
    )),
    getDocsFromServer(collection(db, `${basePath}/${bookId}/annotations`)),
  ]);
  if (!aggregateSnapshot.exists()) return [];
  const aggregate = aggregateSnapshot.data();
  if (!isAnnotationBookAggregateV1(aggregate) || aggregate.bookId !== bookId) {
    throw new Error('원격 annotation aggregate가 올바르지 않습니다.');
  }
  const heads = new Map(headsSnapshot.docs.map((snapshot) => {
    const head = parseAnnotationHeadV1(snapshot.data());
    if (head.bookId !== bookId || head.annotationId !== snapshot.id) {
      throw new Error('원격 annotation head identity가 올바르지 않습니다.');
    }
    return [head.annotationId, head] as const;
  }));
  return Object.keys(aggregate.entries).map((annotationId) => {
    const head = heads.get(annotationId);
    if (!head || head.operation !== 'upsert') {
      throw new Error('원격 annotation aggregate와 head가 일치하지 않습니다.');
    }
    return head;
  });
};
