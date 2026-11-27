import {
  compareReadingUploadTimes,
  isReadingUploadTime,
  type ReadingUploadTime,
} from './readingRollupBootstrap';
import {
  isReadingSessionV1,
  toReadingSessionPayload,
  type ReadingSessionV1,
} from './readingStatistics';

export const READING_STATISTICS_DAY_COLLECTION = 'readingStatsDaysV2';
export const READING_STATISTICS_DAY_MAX_BYTES = 256 * 1024;
export const READING_STATISTICS_DAY_MAX_SESSIONS = 128;
export const READING_STATISTICS_DAY_MAX_INTERVALS = 8_192;
// One release setting applies to all accounts. 'read' keeps published and
// pending v2 data readable while new captures use the legacy writer.
export const readingDayWritesEnabled = () => process.env.NEXT_PUBLIC_READING_STATS_DAY_MODE === 'write';
export const readingDayReadsEnabled = () => readingDayWritesEnabled() || process.env.NEXT_PUBLIC_READING_STATS_DAY_MODE === 'read';

const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const daySessionId = new RegExp(`^day2_(\\d{4}-\\d{2}-\\d{2}_[0-9a-f]{32})_(${uuid})$`);
const uuidPattern = new RegExp(`^${uuid}$`);
const encoder = new TextEncoder();

export type ReadingDayEntry = {
  session: ReadingSessionV1;
  firstReceivedAt: ReadingUploadTime;
};

export type ReadingDayDocument = {
  bucket: string;
  part: number;
  hasNext: boolean;
  deviceId: string;
  capturedDay: string;
  firstReceivedAt: ReadingUploadTime;
  lastReceivedAt: ReadingUploadTime;
  entries: ReadingDayEntry[];
  bytes: number;
  intervals: number;
};

async function readingDayBucket(deviceId: string, day: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(deviceId));
  const device = Array.from(new Uint8Array(hash, 0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${day}_${device}`;
}

export function readingDayBucketFromSessionId(sessionId: string) {
  return daySessionId.exec(sessionId)?.[1];
}

/** The route is derived from the captured day, never from the time of a retry. */
export async function identifyReadingDaySession(session: ReadingSessionV1): Promise<ReadingSessionV1> {
  if (!uuidPattern.test(session.sessionId)) throw new TypeError('Invalid reading session nonce');
  const bucket = await readingDayBucket(session.deviceId, session.localDate);
  return { ...session, sessionId: `day2_${bucket}_${session.sessionId}` };
}

export async function parseReadingDaySession(value: unknown) {
  const input = asRecord(value);
  if (!input || typeof input.startedAtClient !== 'number' || input.startedAtClient > 253_402_300_799_999
    || typeof input.endedAtClient !== 'number' || input.endedAtClient > 253_402_300_799_999
    || !isReadingSessionV1(input)) {
    throw new TypeError('Invalid reading day session');
  }
  const session = daySessionPayload(input);
  const bucket = readingDayBucketFromSessionId(session.sessionId);
  if (!bucket || bucket !== await readingDayBucket(session.deviceId, session.localDate)) {
    throw new TypeError('Invalid reading day identity');
  }
  return { bucket, session };
}

export const readingDayPartId = (bucket: string, part: number) => `${bucket}_${part}`;

function daySessionPayload(session: ReadingSessionV1) {
  const payload = toReadingSessionPayload(session);
  if (payload.activeIntervals) {
    payload.activeIntervals = payload.activeIntervals.map(({ startedAtClient, endedAtClient }) => ({ startedAtClient, endedAtClient }));
  }
  return payload;
}

export function encodeReadingDayMember(session: ReadingSessionV1) {
  const payload = JSON.stringify(daySessionPayload(session));
  // Include the entry key and leave space for Firestore field and Timestamp overhead.
  const bytes = encoder.encode(payload).byteLength + encoder.encode(session.sessionId).byteLength + 64;
  return { payload, bytes, intervals: session.activeIntervals?.length ?? 0 };
}

const asRecord = (value: unknown) => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const copyStamp = ({ seconds, nanoseconds }: ReadingUploadTime) => ({ seconds, nanoseconds });

export function parseReadingDayDocument(value: unknown, documentId: string): ReadingDayDocument {
  const row = asRecord(value);
  const members = asRecord(row?.members);
  if (!row || row.containerVersion !== 2 || typeof row.bucket !== 'string'
    || typeof row.part !== 'number' || !Number.isSafeInteger(row.part) || row.part < 0
    || documentId !== readingDayPartId(row.bucket, row.part)
    || typeof row.hasNext !== 'boolean'
    || typeof row.deviceId !== 'string' || typeof row.capturedDay !== 'string'
    || !isReadingUploadTime(row.firstReceivedAt) || !isReadingUploadTime(row.lastReceivedAt)
    || !members || typeof row.memberCount !== 'number' || row.memberCount < 1 || row.memberCount > READING_STATISTICS_DAY_MAX_SESSIONS
    || Object.keys(members).length !== row.memberCount) {
    throw new TypeError('Invalid reading day document');
  }
  const entries: ReadingDayEntry[] = [];
  let bytes = 0;
  let intervals = 0;
  for (const [id, value] of Object.entries(members)) {
    const member = asRecord(value);
    if (!member || typeof member.payload !== 'string' || !isReadingUploadTime(member.firstReceivedAt)
      || readingDayBucketFromSessionId(id) !== row.bucket
      || compareReadingUploadTimes(member.firstReceivedAt, row.firstReceivedAt) < 0
      || compareReadingUploadTimes(member.firstReceivedAt, row.lastReceivedAt) > 0) {
      throw new TypeError('Invalid reading day member');
    }
    const session: unknown = JSON.parse(member.payload);
    if (!isReadingSessionV1(session) || session.sessionId !== id
      || session.localDate !== row.capturedDay || session.deviceId !== row.deviceId) {
      throw new TypeError('Invalid reading day member payload');
    }
    const encoded = encodeReadingDayMember(session);
    bytes += encoded.bytes;
    intervals += encoded.intervals;
    entries.push({ session: daySessionPayload(session), firstReceivedAt: copyStamp(member.firstReceivedAt) });
  }
  if (bytes > READING_STATISTICS_DAY_MAX_BYTES || intervals > READING_STATISTICS_DAY_MAX_INTERVALS
    || row.bytes !== bytes || row.intervals !== intervals
    || !entries.some(({ firstReceivedAt }) => compareReadingUploadTimes(firstReceivedAt, row.firstReceivedAt as ReadingUploadTime) === 0)
    || !entries.some(({ firstReceivedAt }) => compareReadingUploadTimes(firstReceivedAt, row.lastReceivedAt as ReadingUploadTime) === 0)) {
    throw new TypeError('Invalid reading day bounds');
  }
  return {
    bucket: row.bucket, part: row.part, hasNext: row.hasNext, deviceId: row.deviceId, capturedDay: row.capturedDay,
    firstReceivedAt: copyStamp(row.firstReceivedAt), lastReceivedAt: copyStamp(row.lastReceivedAt), entries, bytes, intervals,
  };
}

export function readingDayEntriesInWindow(
  document: ReadingDayDocument,
  after: ReadingUploadTime | undefined,
  through: ReadingUploadTime,
) {
  return document.entries.filter(({ firstReceivedAt }) => (
    (!after || compareReadingUploadTimes(firstReceivedAt, after) > 0) && compareReadingUploadTimes(firstReceivedAt, through) <= 0
  ));
}
