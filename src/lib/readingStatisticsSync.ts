import {
  collection,
  doc,
  documentId,
  getDocFromServer,
  getDocsFromServer,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  Timestamp,
  type Firestore,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import type {
  QuarantinedReadingStatisticsDocumentV12,
  ReadingStatisticsRemoteCursorV12,
} from './localReadingStatistics';
import {
  getReadingSessionLocalDate,
  parseReadingSessionV1,
  sameReadingSessionPayload,
  toReadingSessionPayload,
  type ReadingSessionV1,
} from './readingStatistics';

const parseRemoteReadingSessionV1 = (value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return toReadingSessionPayload(parseReadingSessionV1(value));
  }
  if (
    'startedAtClient' in value
    && typeof value.startedAtClient === 'number'
    && 'timezoneOffsetMinutes' in value
    && typeof value.timezoneOffsetMinutes === 'number'
  ) {
    return toReadingSessionPayload(parseReadingSessionV1({
      ...value,
      localDate: getReadingSessionLocalDate(
        value.startedAtClient,
        value.timezoneOffsetMinutes,
      ),
    }));
  }
  return toReadingSessionPayload(parseReadingSessionV1(value));
};

const readServerTimestampCursor = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return null;
  if (
    'seconds' in value
    && Number.isSafeInteger(value.seconds)
    && Number(value.seconds) >= 0
    && 'nanoseconds' in value
    && Number.isInteger(value.nanoseconds)
    && Number(value.nanoseconds) >= 0
    && Number(value.nanoseconds) < 1_000_000_000
  ) {
    return {
      uploadedAtServerSeconds: Number(value.seconds),
      uploadedAtServerNanoseconds: Number(value.nanoseconds),
    };
  }
  if ('toMillis' in value && typeof value.toMillis === 'function') {
    const milliseconds = value.toMillis();
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) return null;
    return {
      uploadedAtServerSeconds: Math.floor(milliseconds / 1_000),
      uploadedAtServerNanoseconds: (milliseconds % 1_000) * 1_000_000,
    };
  }
  return null;
};

export const getFirebaseReadingStatisticsPath = (appId: string, uid: string) => (
  `artifacts/${appId}/users/${uid}/libraries/local/readingStatsV1`
);

export const uploadReadingSessionV1 = async (
  firestore: Firestore,
  uid: string,
  session: ReadingSessionV1,
  sdk: Pick<typeof import('firebase/firestore'), 'doc' | 'runTransaction' | 'serverTimestamp'> = {
    doc,
    runTransaction,
    serverTimestamp,
  },
) => {
  const reference = sdk.doc(
    firestore,
    `${getFirebaseReadingStatisticsPath(APP_ID, uid)}/${session.sessionId}`,
  );
  return sdk.runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists()) {
      const remote = parseRemoteReadingSessionV1(snapshot.data());
      if (!sameReadingSessionPayload(remote, session)) {
        return { status: 'conflict', remote } as const;
      }
      return { status: 'replayed' } as const;
    }
    transaction.set(reference, {
      ...toReadingSessionPayload(session),
      uploadedAtServer: sdk.serverTimestamp(),
    });
    return { status: 'created' } as const;
  });
};

export type ReadingStatisticsClockSample = {
  offsetMs: number;
  uncertaintyMs: number;
  measuredAtClient: number;
};

export const readReadingStatisticsClockSampleSingleFlight = (
  inFlight: Map<string, Promise<ReadingStatisticsClockSample | null>>,
  deviceId: string,
  read: () => Promise<ReadingStatisticsClockSample | null>,
) => {
  const existing = inFlight.get(deviceId);
  if (existing) return existing;
  const request = Promise.resolve().then(read).finally(() => {
    if (inFlight.get(deviceId) === request) inFlight.delete(deviceId);
  });
  inFlight.set(deviceId, request);
  return request;
};

export const readReadingStatisticsClockSampleV1 = async (
  firestore: Firestore,
  uid: string,
  sessionId: string,
  requestStartedAt: number,
  requestCompletedAt: number,
  sdk: Pick<typeof import('firebase/firestore'), 'doc' | 'getDocFromServer'> = {
    doc,
    getDocFromServer,
  },
): Promise<ReadingStatisticsClockSample | null> => {
  if (requestCompletedAt < requestStartedAt) return null;
  const uncertaintyMs = Math.ceil((requestCompletedAt - requestStartedAt) / 2);
  if (uncertaintyMs > 5_000) return null;
  const reference = sdk.doc(
    firestore,
    `${getFirebaseReadingStatisticsPath(APP_ID, uid)}/${sessionId}`,
  );
  const snapshot = await sdk.getDocFromServer(reference);
  if (!snapshot.exists()) return null;
  const uploadedAtServer = snapshot.data().uploadedAtServer;
  if (
    typeof uploadedAtServer !== 'object'
    || uploadedAtServer === null
    || !('toMillis' in uploadedAtServer)
    || typeof uploadedAtServer.toMillis !== 'function'
  ) return null;
  const measuredAtClient = Math.floor((requestStartedAt + requestCompletedAt) / 2);
  const offsetMs = uploadedAtServer.toMillis() - measuredAtClient;
  if (!Number.isSafeInteger(offsetMs) || Math.abs(offsetMs) > 24 * 60 * 60_000) return null;
  return { offsetMs, uncertaintyMs, measuredAtClient };
};

export const getRemoteReadingSessionsPageV1 = async (
  firestore: Firestore,
  uid: string,
  cursor: ReadingStatisticsRemoteCursorV12 | null,
  pageSize = 500,
  sdk: Pick<
    typeof import('firebase/firestore'),
    'collection' | 'documentId' | 'getDocsFromServer' | 'limit' | 'orderBy' | 'query' | 'startAfter'
  > = {
    collection,
    documentId,
    getDocsFromServer,
    limit,
    orderBy,
    query,
    startAfter,
  },
  instrumentation: {
    onReadAttempt?: () => void;
    onReadSuccess?: () => void;
  } = {},
) => {
  const reference = sdk.collection(
    firestore,
    getFirebaseReadingStatisticsPath(APP_ID, uid),
  );
  let remoteReadAttemptCount = 0;
  let remoteReadCount = 0;
  const readSnapshot = async (remoteQuery: ReturnType<typeof sdk.query>) => {
    remoteReadAttemptCount += 1;
    instrumentation.onReadAttempt?.();
    const result = await sdk.getDocsFromServer(remoteQuery);
    remoteReadCount += 1;
    instrumentation.onReadSuccess?.();
    return result;
  };
  let snapshot = await readSnapshot(sdk.query(
    reference,
    sdk.orderBy('uploadedAtServer', 'asc'),
    sdk.orderBy(sdk.documentId(), 'asc'),
    ...(cursor ? [sdk.startAfter(
      new Timestamp(cursor.uploadedAtServerSeconds, cursor.uploadedAtServerNanoseconds),
      cursor.documentId,
    )] : []),
    sdk.limit(pageSize),
  ));
  const sessions: ReadingSessionV1[] = [];
  const quarantinedDocuments: QuarantinedReadingStatisticsDocumentV12[] = [];
  let nextCursor = cursor;
  while (true) {
    for (const document of snapshot.docs) {
      const data = document.data() as Record<string, unknown>;
      try {
        const timestampCursor = readServerTimestampCursor(data.uploadedAtServer);
        if (!timestampCursor) {
          throw new Error('원격 독서 통계 upload cursor가 올바르지 않습니다.');
        }
        nextCursor = {
          ...timestampCursor,
          documentId: document.id,
        };
        const session = parseRemoteReadingSessionV1(data);
        if (session.sessionId !== document.id) {
          throw new Error('원격 독서 통계 session identity가 올바르지 않습니다.');
        }
        sessions.push(session);
      } catch (error) {
        quarantinedDocuments.push({
          documentId: document.id,
          reason: (error instanceof Error ? error.message : '원격 독서 통계 문서가 손상되었습니다.')
            .slice(0, 240),
          detectedAt: Date.now(),
        });
      }
    }
    if (snapshot.size < pageSize) break;
    const lastDocument = snapshot.docs.at(-1);
    if (!lastDocument) break;
    const lastData = lastDocument.data() as Record<string, unknown>;
    const lastTimestamp = readServerTimestampCursor(lastData.uploadedAtServer);
    if (lastTimestamp) break;
    snapshot = await readSnapshot(sdk.query(
      reference,
      sdk.orderBy('uploadedAtServer', 'asc'),
      sdk.orderBy(sdk.documentId(), 'asc'),
      sdk.startAfter(lastDocument),
      sdk.limit(pageSize),
    ));
  }
  return {
    sessions,
    quarantinedDocuments,
    nextCursor,
    fullHydrationCompleted: snapshot.size < pageSize,
    remoteReadAttemptCount,
    remoteReadCount,
  };
};
