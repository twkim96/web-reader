import {
  collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy, query, startAfter, Timestamp, where,
  type Firestore,
} from 'firebase/firestore';
import { APP_ID } from './appIdentity';
import { compareReadingUploadTimes, isReadingUploadTime, type ReadingUploadTime } from './readingRollupBootstrap';
import {
  parseReadingDayDocument, readingDayBucketFromSessionId, readingDayEntriesInWindow, readingDayPartId,
  READING_STATISTICS_DAY_COLLECTION, type ReadingDayEntry,
} from './readingStatisticsDay';
import { isReadingSessionV1, toReadingSessionPayload, type ReadingSessionV1 } from './readingStatistics';
import type { ReadingStatisticsClockSample } from './readingStatisticsSync';

const pageSize = 8;
export type ReadingDayReceiveCursor = { updated: ReadingUploadTime; id: string };

const path = (uid: string) => `artifacts/${APP_ID}/users/${uid}/libraries/local/${READING_STATISTICS_DAY_COLLECTION}`;
const stamp = ({ seconds, nanoseconds }: ReadingUploadTime) => new Timestamp(seconds, nanoseconds);
const syncError = (code: string) => Object.assign(new Error('Reading day sync failed'), { code });

type DayUploadResult =
  | { status: 'created'; part: number }
  | { status: 'replayed' }
  | { status: 'conflict'; remote: ReadingSessionV1 };

export async function uploadReadingDaySession(
  user: { getIdToken(): Promise<string> }, session: ReadingSessionV1,
): Promise<DayUploadResult> {
  const token = await user.getIdToken();
  const response = await fetch('/api/reading-statistics/day', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(toReadingSessionPayload(session)),
  });
  if (!response.ok) {
    if (response.status === 401) throw syncError('unauthenticated');
    if (response.status === 403) throw syncError('permission-denied');
    if (response.status === 400 || response.status === 413 || response.status === 422) throw syncError('invalid-argument');
    throw syncError('unavailable');
  }
  const body = await response.json();
  if (body?.status === 'created' && Number.isSafeInteger(body.part) && body.part >= 0) {
    return { status: 'created', part: body.part };
  }
  if (body?.status === 'replayed') return { status: 'replayed' };
  if (body?.status === 'conflict' && isReadingSessionV1(body.remote) && body.remote.sessionId === session.sessionId) {
    return { status: 'conflict', remote: toReadingSessionPayload(body.remote) };
  }
  throw syncError('invalid-argument');
}

export async function getReadingDayReceivePage(
  db: Firestore, uid: string, floor: ReadingUploadTime, cursor: ReadingDayReceiveCursor | null,
  sdk = { collection, documentId, getDocsFromServer, limit, orderBy, query, startAfter, Timestamp, where },
) {
  const maxTimestamp = new sdk.Timestamp(253_402_300_799, 999_999_999);
  const reference = sdk.collection(db, path(uid));
  const cutoff = new sdk.Timestamp(floor.seconds, floor.nanoseconds);
  const snapshot = await sdk.getDocsFromServer(sdk.query(reference,
    sdk.where('lastReceivedAt', '>', cutoff), sdk.where('lastReceivedAt', '<=', maxTimestamp),
    sdk.orderBy('lastReceivedAt'), sdk.orderBy(sdk.documentId()),
    ...(cursor ? [sdk.startAfter(new sdk.Timestamp(cursor.updated.seconds, cursor.updated.nanoseconds), cursor.id)] : []), sdk.limit(pageSize)));
  const rows = new Map<string, ReadingDayEntry>();
  const quarantinedParts: string[] = [];
  let approximateBytes = 0;
  for (const item of snapshot.docs) {
    try {
      const day = parseReadingDayDocument(item.data(), item.id);
      approximateBytes += day.bytes;
      for (const entry of readingDayEntriesInWindow(day, floor, maxTimestamp)) rows.set(entry.session.sessionId, entry);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)) throw error;
      quarantinedParts.push(item.id);
    }
  }
  const last = snapshot.docs.at(-1);
  const at = last?.get('lastReceivedAt');
  if (last && !isReadingUploadTime(at)) throw syncError('invalid-argument');
  const nextCursor = last ? { updated: { seconds: at.seconds, nanoseconds: at.nanoseconds }, id: last.id } : cursor;
  const entries = [...rows.values()].sort((left, right) => (
    compareReadingUploadTimes(left.firstReceivedAt, right.firstReceivedAt)
    || (left.session.sessionId === right.session.sessionId ? 0 : left.session.sessionId < right.session.sessionId ? -1 : 1)
  ));
  return { entries, nextCursor, done: snapshot.size < pageSize, documents: snapshot.size, approximateBytes, quarantinedParts };
}

export async function readReadingDayClockSample(
  db: Firestore, uid: string, sessionId: string, part: number, requestStartedAt: number, requestCompletedAt: number,
): Promise<ReadingStatisticsClockSample | null> {
  const bucket = readingDayBucketFromSessionId(sessionId);
  const uncertaintyMs = Math.ceil((requestCompletedAt - requestStartedAt) / 2);
  if (!bucket || requestCompletedAt < requestStartedAt || uncertaintyMs > 5_000) return null;
  const ref = doc(db, path(uid), readingDayPartId(bucket, part));
  const snapshot = await getDocFromServer(ref);
  const at = snapshot.get(`members.${sessionId}.firstReceivedAt`);
  if (!isReadingUploadTime(at)) return null;
  const measuredAtClient = Math.floor((requestStartedAt + requestCompletedAt) / 2);
  const offsetMs = Math.floor(stamp(at).toMillis()) - measuredAtClient;
  return Math.abs(offsetMs) <= 86_400_000 ? { offsetMs, uncertaintyMs, measuredAtClient } : null;
}
