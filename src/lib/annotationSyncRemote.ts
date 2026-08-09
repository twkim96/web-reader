import {
  collection,
  doc,
  getDocFromServer,
  getDocsFromServer,
  query,
  where,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import { db } from './firebase';
import {
  getFirebaseAnnotationBookAggregatePath,
  getFirebaseAnnotationSyncPath,
  isAnnotationBookAggregateV1,
  parseAnnotationHeadV1,
  toAnnotationSyncSchemaError,
  type AnnotationHeadV1,
} from './annotationSyncSchema';

export const getAuthoritativeRemoteAnnotationHeadV1 = async (
  uid: string,
  bookId: string,
  annotationId: string,
): Promise<AnnotationHeadV1 | null> => {
  const basePath = getFirebaseAnnotationSyncPath(APP_ID, uid);
  const snapshot = await getDocFromServer(doc(
    db,
    `${basePath}/${bookId}/annotations/${annotationId}`,
  ));
  if (!snapshot.exists()) return null;
  try {
    const head = parseAnnotationHeadV1(snapshot.data());
    if (head.bookId !== bookId || head.annotationId !== annotationId) {
      throw new Error('원격 annotation head identity가 올바르지 않습니다.');
    }
    return head;
  } catch (error) {
    throw toAnnotationSyncSchemaError(error);
  }
};

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
    getDocsFromServer(query(
      collection(db, `${basePath}/${bookId}/annotations`),
      where('operation', '==', 'upsert'),
    )),
  ]);
  if (!aggregateSnapshot.exists()) {
    if (!headsSnapshot.empty) {
      throw new Error('원격 annotation head에 aggregate가 없습니다.');
    }
    return [];
  }
  const aggregate = aggregateSnapshot.data();
  if (!isAnnotationBookAggregateV1(aggregate) || aggregate.bookId !== bookId) {
    throw new Error('원격 annotation aggregate가 올바르지 않습니다.');
  }
  const annotationIds = Object.keys(aggregate.entries);
  const heads = new Map(headsSnapshot.docs.map((snapshot) => {
    const head = parseAnnotationHeadV1(snapshot.data());
    if (
      head.bookId !== bookId
      || head.annotationId !== snapshot.id
      || head.operation !== 'upsert'
    ) {
      throw new Error('원격 annotation aggregate와 head가 일치하지 않습니다.');
    }
    return [head.annotationId, head] as const;
  }));
  if (
    heads.size !== annotationIds.length
    || annotationIds.some((annotationId) => !heads.has(annotationId))
  ) throw new Error('원격 annotation aggregate에 대응하는 head가 없습니다.');
  return annotationIds.map((annotationId) => heads.get(annotationId)!);
};
