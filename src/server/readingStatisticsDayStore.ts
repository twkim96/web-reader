import { FieldPath, FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity';
import {
  encodeReadingDayMember,
  parseReadingDaySession,
  readingDayEntriesInWindow,
  readingDayPartId,
  parseReadingDayDocument,
  READING_STATISTICS_DAY_COLLECTION,
  READING_STATISTICS_DAY_MAX_BYTES,
  READING_STATISTICS_DAY_MAX_INTERVALS,
  READING_STATISTICS_DAY_MAX_SESSIONS,
} from '../lib/readingStatisticsDay';
import { isReadingSessionV1 } from '../lib/readingStatistics';

export const readingDaySource = (db: Firestore, uid: string) =>
  db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/${READING_STATISTICS_DAY_COLLECTION}`);

// A later append can move a part forward, never behind a saved cursor. A
// part moved across the cutoff still returns all its old entries. Callers
// scan through the end and deduplicate by immutable session identity.
export function readingDayWindowQuery(db: Firestore, uid: string, after: Timestamp, through: Timestamp) {
  return readingDaySource(db, uid)
    .where('lastReceivedAt', '>', after)
    .where('lastReceivedAt', '<=', new Timestamp(253_402_300_799, 999_999_999))
    .where('firstReceivedAt', '>=', Timestamp.fromMillis(0))
    .where('firstReceivedAt', '<=', through)
    .orderBy('lastReceivedAt')
    .orderBy('firstReceivedAt')
    .orderBy(FieldPath.documentId());
}

export function readReadingDayWindowMemberRows(doc: { id: string; data(): unknown }, after: Timestamp | undefined, through: Timestamp) {
  return readingDayEntriesInWindow(parseReadingDayDocument(doc.data(), doc.id), after, through);
}

// Ordinary reading uses one part. Closed parts are read with a mask on
// retries, so checking an old session does not load the entire day again.
const maxParts = 256;
const count = (value: unknown, maximum: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;

export async function appendReadingDaySession(db: Firestore, uid: string, parsed: Awaited<ReturnType<typeof parseReadingDaySession>>) {
  const { bucket, session } = parsed;
  const source = readingDaySource(db, uid);
  const { payload, bytes, intervals } = encodeReadingDayMember(session);
  if (bytes > READING_STATISTICS_DAY_MAX_BYTES || intervals > READING_STATISTICS_DAY_MAX_INTERVALS) {
    throw new RangeError('Reading session exceeds a day document');
  }
  const at = FieldValue.serverTimestamp();
  const member = { payload, firstReceivedAt: at };
  const memberPath = new FieldPath('members', session.sessionId);
  return db.runTransaction(async (tx) => {
    for (let part = 0; part < maxParts; part++) {
      const ref = source.doc(readingDayPartId(bucket, part));
      const [snapshot] = await tx.getAll(ref, {
        fieldMask: ['containerVersion', 'bucket', 'part', 'hasNext', 'deviceId', 'capturedDay', 'memberCount', 'bytes', 'intervals', memberPath],
      });
      const createPart = (id: number) => tx.create(source.doc(readingDayPartId(bucket, id)), {
        containerVersion: 2, bucket, part: id, deviceId: session.deviceId, capturedDay: session.localDate,
        firstReceivedAt: at, lastReceivedAt: at, hasNext: false, memberCount: 1, bytes, intervals,
        members: { [session.sessionId]: member },
      });
      if (!snapshot.exists) {
        if (part !== 0) throw new Error('Missing reading day part');
        createPart(part);
        return { status: 'created', part } as const;
      }
      const data = snapshot.data()!;
      const existingCount = count(data.memberCount, READING_STATISTICS_DAY_MAX_SESSIONS);
      const existingBytes = count(data.bytes, READING_STATISTICS_DAY_MAX_BYTES);
      const existingIntervals = count(data.intervals, READING_STATISTICS_DAY_MAX_INTERVALS);
      if (data.containerVersion !== 2 || data.bucket !== bucket || data.part !== part
        || data.deviceId !== session.deviceId || data.capturedDay !== session.localDate || typeof data.hasNext !== 'boolean'
        || !existingCount || !existingBytes || existingIntervals === null) {
        throw new Error('Invalid reading day part');
      }
      const existing = snapshot.get(memberPath);
      if (existing !== undefined) {
        if (!(existing.firstReceivedAt instanceof Timestamp) || typeof existing.payload !== 'string') {
          throw new Error('Invalid reading day replay');
        }
        if (existing.payload === payload) return { status: 'replayed' } as const;
        const previous: unknown = JSON.parse(existing.payload);
        if (!isReadingSessionV1(previous) || previous.sessionId !== session.sessionId
          || previous.deviceId !== session.deviceId || previous.localDate !== session.localDate) {
          throw new Error('Invalid reading day replay payload');
        }
        return { status: 'conflict', remote: previous } as const;
      }
      if (data.hasNext) continue;
      if (existingCount < READING_STATISTICS_DAY_MAX_SESSIONS
        && existingBytes + bytes <= READING_STATISTICS_DAY_MAX_BYTES
        && existingIntervals + intervals <= READING_STATISTICS_DAY_MAX_INTERVALS) {
        tx.update(ref, memberPath, member, 'lastReceivedAt', at, 'memberCount', existingCount + 1,
          'bytes', existingBytes + bytes, 'intervals', existingIntervals + intervals);
        return { status: 'created', part } as const;
      } else {
        if (part + 1 === maxParts) throw new RangeError('Reading day exceeds the part limit');
        tx.update(ref, { hasNext: true });
        createPart(part + 1);
        return { status: 'created', part: part + 1 } as const;
      }
    }
    throw new Error('Invalid reading day part chain');
  });
}
