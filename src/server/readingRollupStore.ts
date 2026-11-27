import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  FieldPath, FieldValue, Timestamp, type DocumentReference, type Firestore, type QueryDocumentSnapshot, type Transaction,
} from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity.ts';
import {
  isReadingSessionV1, READING_SESSION_MAX_CLOCK_OFFSET_MS, sameReadingSessionPayload, toReadingSessionPayload, type ReadingSessionV1,
} from '../lib/readingStatistics.ts';
import { READING_STATISTICS_DAY_MAX_INTERVALS, type ReadingDayEntry } from '../lib/readingStatisticsDay';
import { mergeReadingReportBooks, parseReadingReportBooks, summarizeReadingReportBooks, type ReadingReportBook } from '../lib/readingStatisticsReport.ts';
import { compareReadingUploadTimes, isReadingUploadTime, selectReadingRollupTail } from '../lib/readingRollupBootstrap.ts';
import {
  computeReadingCalendarRollup, computeWeeklyReadingRollup, isReadingRollupHandoffWeekCount, parseReadingRollupMonday, READING_CALENDAR_WEEK_COUNT,
  mergeReadingFileRollups, parseReadingFileRollups, readReadingRollupDays, readingRollupWeekForDay, selectWeeklyReadingRollupInputs,
  type ReadingFileRollup, type WeeklyReadingRollup,
} from '../lib/readingStatisticsRollup.ts';
import {
  addReadingRollupPageWithoutChangingClosedWeek, closedReadingAllocationDigest, createReadingRollupCarry,
  rollupCoversHistoryStart, sortReadingRollupCarry, type ReadingRollupCarry,
} from './readingRollupInputs.ts';
import { readReadingDayWindowMemberRows, readingDaySource, readingDayWindowQuery } from './readingStatisticsDayStore';

const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * day;
const leaseDuration = 5 * 60_000;
const dailySourceReads = 4_000;
const pageSize = 100;
const dayPageSize = 8;
const daySpillThreshold = 192 * 1024;
const daySpillChunkBytes = 384 * 1024;
const maxDaySpillBytes = 32 * 1024 * 1024;
const maxDaySpillChunks = 128;
const dayCleanupBatchSize = 8;
const dayCleanupBatchLimit = 24;
const maxJobPayloadBytes = 512 * 1024;
const maxDecodedCarryBytes = 8 * 1024 * 1024;
const enrollmentPageSize = 20;
const bootstrapChunkBytes = 512 * 1024;
const maxBootstrapPageBytes = 8 * 1024 * 1024;
const maxBootstrapChunks = 256;
const maxBootstrapInputBytes = 32 * 1024 * 1024;
const sourcePagesPerTurn = 10;
const retryDelay = hour;
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const root = `artifacts/${APP_ID}`;
const jobs = (db: Firestore) => db.collection(`${root}/readingStatsRollupJobsV1`);
const dayCleanupQueue = (db: Firestore) => db.collection(`${root}/readingStatsRollupDayCleanupV2`);
const leaseRef = (db: Firestore, uid: string) => db.doc(`${root}/readingStatsRollupLeasesV1/${uid}`);
const sourceRef = (db: Firestore, uid: string) => db.collection(`${root}/users/${uid}/libraries/local/readingStatsV1`);
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const stamp = (time: Timestamp) => [time.seconds, time.nanoseconds] as const;
type Stamp = ReturnType<typeof stamp>;
type Cursor = { time: Stamp; id: string };
type DayCursor = { updated: Stamp; first: Stamp; id: string };
type DayInputPosition = { firstReceivedAt: ReadingDayEntry['firstReceivedAt']; id: string };
type DayScan = {
  cursor: DayCursor | null; scanned: boolean; pending: ReadingDayEntry[]; legacyPending?: ReadingDayEntry[];
  spillCount?: number; spillBytes?: number; appliedDay?: DayInputPosition;
};
type RollupSourceMetrics = {
  legacyDocuments: number;
  dayDocuments: number;
  inputSessions: number;
  inputIntervals: number;
  quarantinedDayDocuments: number;
  daySpillReads: number;
  daySpillWrites: number;
  weeklyCheckpointWrites: number;
  dayCleanupDocuments: number;
  dayCleanupFailures: number;
};
type WeekSummary = Pick<WeeklyReadingRollup, 'weekStart' | 'days'>;
type Job = {
  firstWeek: string;
  nextWeek: string;
  sourceAfter: Stamp;
  closeAt: Stamp;
  cursor: Cursor | null;
  scanned: boolean;
  dayScan?: DayScan;
  carry: ReadingRollupCarry;
  closedAllocation?: { sessionCount: number; digest: string };
  tailPolicy?: 1 | 2;
  handoffSourceThrough?: Stamp;
  dayHandoffThrough?: Stamp;
  group: WeekSummary[];
  lastCalendarWeek: string | null;
  coversHistoryStart?: boolean;
  evidenceCompatible?: boolean;
  evidenceSeedThrough?: Stamp;
};
type Compression = { encoding: 'gzip-v1'; data: string };
type PersistedJob = Omit<Job, 'carry' | 'dayScan'> & {
  carry: ReadingRollupCarry | Compression;
  dayScan?: Omit<DayScan, 'pending' | 'legacyPending'> & {
    pending: ReadingDayEntry[] | Compression;
    legacyPending?: ReadingDayEntry[] | Compression;
  };
};

type Lease = { uid: string; token: string };
type RollupBootstrap = {
  cutoff: Timestamp | null; cursor: string | null; chunks: number; bytes: number; scanned: boolean;
  dayCursor?: DayCursor | null; daysScanned?: boolean;
};
type ListRollupAccounts = (limit: number, pageToken?: string) => Promise<{
  users: { uid: string; disabled: boolean }[]; pageToken?: string;
}>;
class InvalidRollupInput extends Error {}

export async function claimReadingRollup(db: Firestore, uid: string, now = Date.now) {
  const ref = leaseRef(db, uid);
  const token = randomUUID();
  return db.runTransaction(async (tx): Promise<Lease | null> => {
    const snapshot = await tx.get(ref);
    const current = now();
    if ((snapshot.get('expiresAt') ?? 0) > current) return null;
    tx.set(ref, { token, expiresAt: current + leaseDuration });
    return { uid, token };
  });
}

async function requireLease(db: Firestore, tx: Transaction, lease: Lease, now: () => number) {
  const ref = leaseRef(db, lease.uid);
  const snapshot = await tx.get(ref);
  if (snapshot.get('token') !== lease.token || snapshot.get('expiresAt') <= now()) throw new Error('Reading rollup lease lost.');
  return ref;
}

export async function releaseReadingRollup(db: Firestore, { uid, token }: Lease) {
  const ref = leaseRef(db, uid);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).get('token') === token) tx.delete(ref);
  });
}

async function reserveSourceReads(db: Firestore, tx: Transaction, requested: number, current: number) {
  const quotaDay = quotaDate.format(current);
  // Avoid reservations whose query window would straddle the quota reset.
  if (quotaDate.format(current + leaseDuration) !== quotaDay) return 0;
  const budget = db.doc(`${root}/readingStatsRollupBudgetsV1/${quotaDay}`);
  const reads = (await tx.get(budget)).get('sourceReads') ?? 0;
  const allowed = Math.max(0, Math.min(requested, dailySourceReads - reads));
  if (allowed > 0) tx.set(budget, { sourceReads: reads + allowed });
  return allowed;
}

export async function reserveReadingRollupReads(db: Firestore, lease: Lease, requested: number, now = Date.now) {
  if (!Number.isInteger(requested) || requested < 1 || requested > pageSize) throw new RangeError('Invalid source page size.');
  return db.runTransaction(async (tx) => {
    const ref = await requireLease(db, tx, lease, now);
    const current = now();
    const allowed = await reserveSourceReads(db, tx, requested, current);
    if (allowed > 0) tx.update(ref, { expiresAt: current + leaseDuration });
    return allowed;
  });
}

function weeklyClose(weekStart: string) {
  return parseReadingRollupMonday(weekStart) + week + day + 9 * hour;
}

const accountHash = (uid: string) => createHash('sha256').update(uid).digest().readUInt32BE();

function queueOrder(close: number, hash: number, pilot = false) {
  // Due keys lie within the final millisecond before the common cutoff. The
  // integer clock sees them all at the cutoff, using the existing dueAt index.
  const lanes = 2_048;
  const priority = pilot ? 1 : 2 + hash % (lanes - 2);
  return close - 1 + priority / lanes;
}

function payload(value: unknown, maxKiB: number) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxKiB * 1024) throw new InvalidRollupInput('rollup-payload-too-large');
  return json;
}

function jobPayload(job: Job) {
  const json = JSON.stringify(job);
  // Keep small checkpoints readable by older writers, including after rollover.
  if (Buffer.byteLength(json) <= maxJobPayloadBytes) return json;

  const compress = (value: unknown): Compression => {
    const encoded = Buffer.from(JSON.stringify(value));
    if (encoded.length > maxDecodedCarryBytes) throw new InvalidRollupInput('rollup-payload-too-large');
    return { encoding: 'gzip-v1', data: gzipSync(encoded).toString('base64') };
  };
  return payload({
    ...job, carry: compress(job.carry),
    ...(job.dayScan && { dayScan: { ...job.dayScan, pending: compress(job.dayScan.pending),
      legacyPending: job.dayScan.legacyPending?.length ? compress(job.dayScan.legacyPending) : undefined } }),
  }, maxJobPayloadBytes / 1024);
}

function decodeJobField<T>(value: T | Compression): T {
  if (!value || typeof value !== 'object' || !('encoding' in value)) return value as T;
  if (value.encoding !== 'gzip-v1' || !('data' in value) || typeof value.data !== 'string') throw new Error();
  const json = gunzipSync(Buffer.from(value.data, 'base64'), { maxOutputLength: maxDecodedCarryBytes });
  return JSON.parse(json.toString('utf8')) as T;
}

function readJobPayload(payload: string): Job {
  try {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > maxJobPayloadBytes) throw new Error();
    const job = JSON.parse(payload) as PersistedJob;
    const carry = decodeJobField(job.carry);
    const dayScan = job.dayScan && { ...job.dayScan, pending: decodeJobField(job.dayScan.pending),
      legacyPending: decodeJobField(job.dayScan.legacyPending) };
    const nextWeek = parseReadingRollupMonday(job.nextWeek);
    if (parseReadingRollupMonday(job.firstWeek) > nextWeek
      || !Number.isSafeInteger(carry.sampleFloor) || !Array.isArray(carry.sessions) || !carry.sessions.every(isReadingSessionV1)
      || !Array.isArray(job.group) || job.group.length >= READING_CALENDAR_WEEK_COUNT
      || !isRollupStamp(job.sourceAfter) || !isRollupStamp(job.closeAt)
      || (job.handoffSourceThrough !== undefined && !isRollupStamp(job.handoffSourceThrough))
      || (job.dayHandoffThrough !== undefined && !isRollupStamp(job.dayHandoffThrough))
      || (job.evidenceSeedThrough !== undefined && !isRollupStamp(job.evidenceSeedThrough))
      || typeof job.scanned !== 'boolean'
      || (job.cursor !== null && (!isRollupStamp(job.cursor?.time) || typeof job.cursor.id !== 'string'))
      || (dayScan !== undefined && (typeof dayScan.scanned !== 'boolean' || !isDayCursor(dayScan.cursor)
        || !validReadingDayRows(dayScan.pending)
        || !validDaySpill(dayScan)
        || (dayScan.legacyPending !== undefined && (!validReadingDayRows(dayScan.legacyPending)
          || dayScan.legacyPending.length > pageSize))))
      || (job.closedAllocation !== undefined && (!Number.isSafeInteger(job.closedAllocation?.sessionCount)
        || job.closedAllocation.sessionCount < 0 || job.closedAllocation.sessionCount > carry.sessions.length
        || typeof job.closedAllocation.digest !== 'string'))) throw new Error();
    if (job.lastCalendarWeek !== null) parseReadingRollupMonday(job.lastCalendarWeek);
    const group = job.group.map((item, index) => {
      const start = nextWeek - (job.group.length - index) * week;
      if (item.weekStart !== date(start)) throw new Error();
      return { weekStart: item.weekStart, days: readReadingRollupDays(item.days, start, start + 6 * day) };
    });
    return { ...job, carry, group, dayScan };
  } catch {
    throw new InvalidRollupInput('invalid-rollup-checkpoint');
  }
}

function isDayCursor(value: DayCursor | null) {
  return value === null || !!value && isRollupStamp(value.updated) && isRollupStamp(value.first) && typeof value.id === 'string';
}

function validReadingDayRows(value: unknown): value is ReadingDayEntry[] {
  return Array.isArray(value) && value.every((entry) =>
    entry && isReadingSessionV1(entry.session) && isReadingUploadTime(entry.firstReceivedAt));
}

function validDaySpill(scan: Pick<DayScan, 'spillCount' | 'spillBytes' | 'appliedDay'>) {
  if (scan.spillCount === undefined) return scan.spillBytes === undefined && scan.appliedDay === undefined;
  return Number.isSafeInteger(scan.spillCount) && scan.spillCount > 0 && scan.spillCount <= maxDaySpillChunks
    && typeof scan.spillBytes === 'number' && Number.isSafeInteger(scan.spillBytes)
    && scan.spillBytes > 0 && scan.spillBytes <= maxDaySpillBytes
    && (scan.appliedDay === undefined || typeof scan.appliedDay.id === 'string' && isReadingUploadTime(scan.appliedDay.firstReceivedAt));
}

const dayCursor = (doc: QueryDocumentSnapshot): DayCursor => ({
  updated: stamp(doc.get('lastReceivedAt')), first: stamp(doc.get('firstReceivedAt')), id: doc.id,
});

function getRollupDayPage(
  db: Firestore, uid: string, after: Timestamp, through: Timestamp, cursor: DayCursor | null | undefined, limit: number,
) {
  const query = readingDayWindowQuery(db, uid, after, through);
  return (cursor ? query.startAfter(new Timestamp(...cursor.updated), new Timestamp(...cursor.first), cursor.id) : query).limit(limit).get();
}

function rollupDayRows(doc: QueryDocumentSnapshot, after: Timestamp | undefined, through: Timestamp, metrics: RollupSourceMetrics) {
  try { return readReadingDayWindowMemberRows(doc, after, through); }
  catch (error) {
    if (!(error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError)) throw error;
    metrics.quarantinedDayDocuments++;
    return [];
  }
}

function compareReceivedRows(left: ReadingDayEntry, right: ReadingDayEntry) {
  return compareReadingUploadTimes(left.firstReceivedAt, right.firstReceivedAt)
    || Buffer.compare(Buffer.from(left.session.sessionId), Buffer.from(right.session.sessionId));
}

function takeRollupInputRows(job: Job, scan: DayScan, spilled: ReadingDayEntry[] | null) {
  const rows: ReadingDayEntry[] = [];
  const legacy = scan.legacyPending ?? [];
  const dayRows = spilled ?? scan.pending;
  const through = job.cursor && new Timestamp(...job.cursor.time);
  let dayIndex = 0;
  let legacyIndex = 0;
  let intervals = 0;
  while (rows.length < pageSize) {
    const day = dayRows[dayIndex];
    const original = legacy[legacyIndex];
    const dayReady = day && (job.scanned || through && job.cursor
      && (compareReadingUploadTimes(day.firstReceivedAt, through)
        || Buffer.compare(Buffer.from(day.session.sessionId), Buffer.from(job.cursor.id))) <= 0);
    const useDay = dayReady && (!original || compareReceivedRows(day, original) < 0);
    const row = useDay ? day : original;
    if (!row) break;
    intervals += row.session.activeIntervals?.length ?? 1;
    if (intervals > READING_STATISTICS_DAY_MAX_INTERVALS) break;
    rows.push(row);
    if (useDay) dayIndex++;
    else legacyIndex++;
  }
  if (spilled && dayIndex) {
    const last = dayRows[dayIndex - 1];
    scan.appliedDay = { firstReceivedAt: last.firstReceivedAt, id: last.session.sessionId };
  }
  dayRows.splice(0, dayIndex);
  if (scan.legacyPending) scan.legacyPending.splice(0, legacyIndex);
  return rows;
}

function collectDayScanPage(
  scan: DayScan, docs: readonly QueryDocumentSnapshot[], after: Timestamp, through: Timestamp, limit: number, metrics: RollupSourceMetrics,
): DayScan {
  const pending = new Map(scan.pending.map((entry) => [entry.session.sessionId, entry]));
  for (const doc of docs) {
    for (const entry of rollupDayRows(doc, after, through, metrics)) {
      const previous = pending.get(entry.session.sessionId);
      if (previous && (!sameReadingSessionPayload(previous.session, entry.session)
        || compareReadingUploadTimes(previous.firstReceivedAt, entry.firstReceivedAt))) {
        throw new InvalidRollupInput('conflicting-day-input');
      }
      pending.set(entry.session.sessionId, entry);
    }
  }
  const last = docs.at(-1);
  const scanned = docs.length < limit;
  const entries = [...pending.values()];
  if (scanned) entries.sort(compareReceivedRows);
  return { ...scan, cursor: last ? dayCursor(last) : scan.cursor, scanned, pending: entries };
}

const daySpillRef = (ref: DocumentReference, week: string, index: number) => (
  ref.collection('readingStatsRollupDayChunksV2').doc(`${week}_${String(index).padStart(4, '0')}`)
);

const dayCleanupJobId = (uid: string, week: string) => `${week}_${createHash('sha256').update(uid).digest('hex')}`;

async function cleanPublishedDayChunks(db: Firestore, task: DocumentReference) {
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(task);
    if (!snapshot.exists) return { deleted: 0, remaining: 0 };
    const { uid, week, remaining: end } = snapshot.data()!;
    if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/') || uid === '.' || uid === '..'
      || typeof week !== 'string' || task.id !== dayCleanupJobId(uid, week)
      || !Number.isSafeInteger(end) || end < 1 || end > maxDaySpillChunks) {
      throw new InvalidRollupInput('invalid-day-cleanup-task');
    }
    parseReadingRollupMonday(week);
    const remaining = Math.max(0, end - dayCleanupBatchSize);
    const ref = jobs(db).doc(uid);
    for (let index = remaining; index < end; index++) tx.delete(daySpillRef(ref, week, index));
    if (remaining) tx.update(task, { remaining });
    else tx.delete(task);
    return { deleted: end - remaining, remaining };
  });
}

function spillDayInputs(scan: DayScan) {
  if (Buffer.byteLength(JSON.stringify(scan.pending)) <= daySpillThreshold) return [];
  const chunks: string[] = [];
  let rows: string[] = [];
  let bytes = 2;
  for (const row of scan.pending) {
    const encoded = JSON.stringify(row);
    const size = Buffer.byteLength(encoded) + 1;
    if (bytes + size > daySpillChunkBytes && rows.length) {
      chunks.push(`[${rows.join(',')}]`);
      rows = [];
      bytes = 2;
    }
    rows.push(encoded);
    bytes += size;
  }
  if (rows.length) chunks.push(`[${rows.join(',')}]`);
  scan.spillCount = (scan.spillCount ?? 0) + chunks.length;
  scan.spillBytes = (scan.spillBytes ?? 0) + chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  if (!validDaySpill(scan)) throw new InvalidRollupInput('day-inputs-too-large');
  scan.pending = [];
  return chunks;
}

async function readSpilledDayInputs(
  db: Firestore, ref: DocumentReference, job: Job, scan: DayScan, stopAt: number, now: () => number, metrics: RollupSourceMetrics,
) {
  const entries = new Map<string, ReadingDayEntry>();
  const applied = scan.appliedDay;
  const keep = (entry: ReadingDayEntry) => {
    if (applied && (compareReadingUploadTimes(entry.firstReceivedAt, applied.firstReceivedAt)
      || Buffer.compare(Buffer.from(entry.session.sessionId), Buffer.from(applied.id))) <= 0) return;
    const previous = entries.get(entry.session.sessionId);
    if (previous && (!sameReadingSessionPayload(previous.session, entry.session)
      || compareReadingUploadTimes(previous.firstReceivedAt, entry.firstReceivedAt))) {
      throw new InvalidRollupInput('conflicting-day-input');
    }
    entries.set(entry.session.sessionId, entry);
  };
  for (const row of scan.pending) keep(row);
  const count = scan.spillCount ?? 0;
  let bytes = 0;
  for (let from = 0; from < count; from += 16) {
    if (now() >= stopAt) return null;
    const docs = await db.getAll(...Array.from({ length: Math.min(count - from, 16) }, (_, i) => daySpillRef(ref, job.nextWeek, from + i)));
    metrics.daySpillReads += docs.length;
    for (const doc of docs) {
      try {
        const payload: unknown = doc.get('payload');
        if (typeof payload !== 'string') throw new Error();
        bytes += Buffer.byteLength(payload);
        if (bytes > maxDaySpillBytes || Buffer.byteLength(payload) > daySpillChunkBytes) throw new Error();
        const rows: unknown = JSON.parse(payload);
        if (!validReadingDayRows(rows)) throw new Error();
        for (const row of rows) keep(row);
      } catch (error) {
        if (error instanceof InvalidRollupInput) throw error;
        throw new InvalidRollupInput('invalid-day-input-page');
      }
    }
  }
  if (bytes !== scan.spillBytes) throw new InvalidRollupInput('invalid-day-input-size');
  return [...entries.values()].sort(compareReceivedRows);
}

function isRollupStamp(value: unknown): value is Stamp {
  return Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0])
    && value[0] >= -62_135_596_800 && value[0] <= 253_402_300_799
    && Number.isSafeInteger(value[1]) && value[1] >= 0 && value[1] < 1_000_000_000;
}

function validateBootstrapCheckpoint(value: RollupBootstrap) {
  if (!value || typeof value !== 'object'
    || (value.cutoff !== null && !(value.cutoff instanceof Timestamp))
    || (value.cursor !== null && typeof value.cursor !== 'string')
    || !Number.isSafeInteger(value.chunks) || value.chunks < 0 || value.chunks > maxBootstrapChunks
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > maxBootstrapInputBytes
    || typeof value.scanned !== 'boolean' || (value.chunks > 0 && !value.cutoff)
    || (value.dayCursor !== undefined && !isDayCursor(value.dayCursor))
    || (value.daysScanned !== undefined && typeof value.daysScanned !== 'boolean')) {
    throw new InvalidRollupInput('invalid-bootstrap-checkpoint');
  }
}

type BootstrapInput = { session: ReadingSessionV1; firstReceivedAt?: ReadingDayEntry['firstReceivedAt'] };

function readBootstrapChunk(value: unknown) {
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > bootstrapChunkBytes) throw new Error();
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows)) throw new Error();
    return rows.map((row): BootstrapInput => {
      if (isReadingSessionV1(row)) return { session: row };
      if (row && isReadingSessionV1(row.session)
        && (row.firstReceivedAt === undefined || isReadingUploadTime(row.firstReceivedAt))) return row;
      throw new Error();
    });
  } catch {
    throw new InvalidRollupInput('invalid-bootstrap-page');
  }
}

const fileTotalsRef = (ref: DocumentReference) => ref.collection('readingStatsRollupFilesV1').doc('current');

function rollupFilePayload(files: ReadingFileRollup[], books: ReadingReportBook[] | null, carry?: ReadingRollupCarry, evidenceCompatible?: boolean) {
  const maxBytes = 768 * 1024;
  const carryFields = carry ? { carry, evidenceCompatible: evidenceCompatible === true } : {};
  if (books) {
    const withBooks = JSON.stringify({ files, books, ...carryFields });
    if (Buffer.byteLength(withBooks) <= maxBytes) return withBooks;
  }
  if (carry) {
    const withCarry = JSON.stringify({ files, ...carryFields });
    if (Buffer.byteLength(withCarry) <= maxBytes) return withCarry;
  }
  if (books && carry) {
    const withoutCarry = JSON.stringify({ files, books });
    if (Buffer.byteLength(withoutCarry) <= maxBytes) return withoutCarry;
  }
  const json = JSON.stringify({ files });
  return Buffer.byteLength(json) <= maxBytes ? json : null;
}

function parseFilePayload(payload: string) {
  try {
    const value = JSON.parse(payload);
    const files = parseReadingFileRollups(value.files);
    return files ? { files, books: parseReadingReportBooks(value.books) } : null;
  }
  catch { return null; }
}

/** Stage previous calendar blocks and the nine weeks awaiting their first regular close. */
export async function stageReadingRollupHandoff(db: Firestore, lease: Lease, seed: {
  weeks: WeeklyReadingRollup[];
  nextWeek: string;
  sourceCutoff: Timestamp;
  carry: ReadingRollupCarry;
  pilotTuesday: boolean;
  coversHistoryStart?: boolean;
  evidenceCompatible?: boolean;
  coversDaySource?: boolean;
}, now = Date.now, bootstrapChunks?: number) {
  const { nextWeek, sourceCutoff, carry, pilotTuesday } = seed;
  const staged = seed.weeks.map(({ weekStart, days }) => ({ weekStart, days }));
  if (!isReadingRollupHandoffWeekCount(staged.length)) {
    throw new RangeError('Handoff requires 10 consecutive weeks including the first regular close, with optional earlier 10-week blocks.');
  }
  const firstWeek = staged[0].weekStart;
  const firstMonday = parseReadingRollupMonday(firstWeek);
  if (staged.some(({ weekStart }, i) => weekStart !== date(firstMonday + i * week))
    || nextWeek !== date(firstMonday + staged.length * week)) throw new TypeError('Invalid rollup handoff order.');
  const earlierWeeks = staged.length + 1 - READING_CALENDAR_WEEK_COUNT;
  const group = staged.slice(earlierWeeks);
  const calendars: { lastWeek: string; payload: string }[] = [];
  for (let i = 0; i < earlierWeeks; i += READING_CALENDAR_WEEK_COUNT) {
    const block = computeReadingCalendarRollup(staged.slice(i, i + READING_CALENDAR_WEEK_COUNT));
    calendars.push({ lastWeek: block.weekStarts[0], payload: payload(block, 128) });
  }
  const hash = accountHash(lease.uid);
  const close = weeklyClose(nextWeek);
  const job: Job = {
    firstWeek, nextWeek, closeAt: stamp(Timestamp.fromMillis(close).valueOf() > sourceCutoff.valueOf()
      ? Timestamp.fromMillis(close) : sourceCutoff),
    // Replay one day at the seam because the Mac used document createTime and
    // regular uploads use uploadedAtServer. Session IDs make the replay idempotent.
    sourceAfter: stamp(Timestamp.fromMillis(sourceCutoff.toMillis() - day)), cursor: null, scanned: false,
    carry, group, lastCalendarWeek: calendars.at(-1)?.lastWeek ?? null,
  };
  const ref = jobs(db).doc(lease.uid);
  // Hash the original seed JSON so the identity is independent of storage encoding.
  const seedPayload = JSON.stringify(job);
  const proposed = jobPayload({ ...job,
    handoffSourceThrough: stamp(sourceCutoff),
    ...(seed.coversDaySource ? { dayHandoffThrough: stamp(sourceCutoff) } : {}),
    ...(seed.coversHistoryStart ? { coversHistoryStart: true } : {}),
    ...(seed.evidenceCompatible ? { evidenceCompatible: true, evidenceSeedThrough: stamp(sourceCutoff) } : {}),
  });
  const weeks = seed.weeks.map((item) => ({ weekStart: item.weekStart, payload: payload(item, 256) }));
  const seedId = createHash('sha256').update(seedPayload).update(JSON.stringify(weeks)).digest('hex');
  const files = rollupFilePayload(
    mergeReadingFileRollups(...seed.weeks.map((item) => item.files)),
    summarizeReadingReportBooks(seed.weeks.flatMap((item) => item.activities)),
  );
  return db.runTransaction(async (tx) => {
    await requireLease(db, tx, lease, now);
    const existing = await tx.get(ref);
    if (bootstrapChunks !== undefined) {
      const bootstrap: RollupBootstrap | undefined = existing.get('bootstrap');
      if (!bootstrap?.scanned || !bootstrap.daysScanned || bootstrap.chunks !== bootstrapChunks) {
        throw new Error('Reading rollup bootstrap changed.');
      }
      // Firestore limits the size of the atomic first publication's staged writes.
      const stagedBytes = Buffer.byteLength(proposed) + Buffer.byteLength(files ?? '')
        + weeks.reduce((bytes, item) => bytes + Buffer.byteLength(item.payload), 0)
        + calendars.reduce((bytes, item) => bytes + Buffer.byteLength(item.payload), 0);
      if (stagedBytes > 9 * 1024 * 1024 || weeks.length + calendars.length + 2 > 500) {
        throw new InvalidRollupInput('bootstrap-publication-too-large');
      }
    } else if (existing.exists) {
      const saved = existing.get('seedId');
      if (saved !== seedId) {
        const slot = pilotTuesday ? 1 : hash % 6;
        const priorClose = parseReadingRollupMonday(nextWeek) + week + Math.max(14 * hour, slot * day + 9 * hour);
        const legacySeed = { firstWeek, nextWeek, slot, closeAt: stamp(Timestamp.fromMillis(priorClose).valueOf() > sourceCutoff.valueOf()
          ? Timestamp.fromMillis(priorClose) : sourceCutoff),
        sourceAfter: job.sourceAfter, cursor: null, scanned: false, carry, group, lastCalendarWeek: job.lastCalendarWeek };
        const legacyId = createHash('sha256').update(JSON.stringify(legacySeed)).update(JSON.stringify(weeks)).digest('hex');
        if (saved !== legacyId) throw new Error('A different reading rollup handoff already exists.');
      }
      if (files && (JSON.parse(existing.get('payload')) as Pick<Job, 'nextWeek'>).nextWeek === nextWeek) {
        const existingFiles = await tx.get(fileTotalsRef(ref));
        if (!existingFiles.exists || !parseFilePayload(existingFiles.get('payload'))?.books) {
          tx.set(fileTotalsRef(ref), { throughWeek: weeks.at(-1)!.weekStart, payload: files });
        }
      }
      return 'already-staged';
    }
    for (const { weekStart, payload } of weeks) tx.create(ref.collection('readingStatsRollupWeeksV1').doc(weekStart), { payload });
    for (const { lastWeek, payload } of calendars) tx.create(ref.collection('readingStatsRollupCalendarsV1').doc(lastWeek), { payload });
    if (files) tx.create(fileTotalsRef(ref), { throughWeek: weeks.at(-1)!.weekStart, payload: files });
    const scheduled = { payload: proposed, dueAt: queueOrder(close, hash, pilotTuesday), seedId };
    if (bootstrapChunks === undefined) tx.create(ref, scheduled);
    else tx.set(ref, { ...scheduled, bootstrapCleanup: bootstrapChunks });
    return 'staged';
  });
}

async function saveRollupJob(db: Firestore, lease: Lease, now: () => number, write: (tx: Transaction) => void) {
  await db.runTransaction(async (tx) => {
    await requireLease(db, tx, lease, now);
    write(tx);
  });
}

async function enrollReadingRollupAccounts(db: Firestore, list: ListRollupAccounts, stopAt: number, now: () => number) {
  const state = db.doc(`${root}/readingStatsRollupEnrollmentV1/current`);
  const previous = await state.get();
  const today = quotaDate.format(now());
  if (previous.get('scannedDay') === today) return 0;
  const cursor = previous.get('pageToken') as string | undefined;
  const { users, pageToken } = await list(enrollmentPageSize, cursor);
  if (now() >= stopAt) return 0;
  const refs = users.filter(({ uid, disabled }) => !disabled && uid !== '.' && uid !== '..' && !uid.includes('/') && !/^__.*__$/.test(uid))
    .map(({ uid }) => jobs(db).doc(uid));
  const current = refs.length ? await db.getAll(...refs, { fieldMask: ['dueAt'] }) : [];
  const candidates = current.filter((doc) => !doc.exists);
  if (now() >= stopAt) return 0;
  const allowed = candidates.length
    ? await db.runTransaction((tx) => reserveSourceReads(db, tx, candidates.length, now()))
    : 0;
  if (now() >= stopAt) return 0;
  const searched = await Promise.all(candidates.slice(0, allowed).map(async ({ ref }) => ({
    ref, exists: !(await sourceRef(db, ref.id).limit(1).select().get()).empty,
  })));
  const found = searched.filter(({ exists }) => exists).map(({ ref }) => ref);
  const withoutSessions = searched.filter(({ exists }) => !exists);
  const dayAllowed = withoutSessions.length
    ? await db.runTransaction((tx) => reserveSourceReads(db, tx, withoutSessions.length, now()))
    : 0;
  if (now() >= stopAt) return 0;
  const newDayAccounts = await Promise.all(withoutSessions.slice(0, dayAllowed).map(async ({ ref }) =>
    (await readingDaySource(db, ref.id).limit(1).select().get()).empty ? null : ref,
  ));
  found.push(...newDayAccounts.filter((ref) => ref !== null));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(state);
    if (snapshot.get('pageToken') !== cursor || snapshot.get('scannedDay') === today) return 0;
    const existing = found.length ? await tx.getAll(...found, { fieldMask: ['dueAt'] }) : [];
    const newJobs = existing.filter((doc) => !doc.exists);
    for (const { ref } of newJobs) {
      const bootstrap: RollupBootstrap = { cutoff: null, cursor: null, chunks: 0, bytes: 0, scanned: false };
      tx.create(ref, { bootstrap, bootstrapDueAt: now() });
    }
    if (allowed === candidates.length && dayAllowed === withoutSessions.length) {
      tx.set(state, { scannedDay: today, ...(pageToken ? { pageToken } : {}) });
    }
    return newJobs.length;
  });
}

const bootstrapChunk = (ref: DocumentReference, index: number) => (
  ref.collection('readingStatsRollupBootstrapChunksV1').doc(String(index))
);

function encodeBootstrapPage(documents: readonly QueryDocumentSnapshot[], sessions: (doc: QueryDocumentSnapshot) => BootstrapInput[]) {
  const chunks: string[] = [];
  let rows: string[] = [];
  let size = 2;
  let examined = 0;
  let pageBytes = 0;
  for (const doc of documents) {
    const encoded = sessions(doc).map((session) => {
      const row = JSON.stringify(session);
      return { row, bytes: Buffer.byteLength(row) + 1 };
    }).filter(({ bytes }) => bytes + 2 <= bootstrapChunkBytes);
    const documentBytes = encoded.reduce((total, { bytes }) => total + bytes, 0);
    // Leave a Firestore request-size margin for chunk boundaries and metadata.
    if (pageBytes + documentBytes > maxBootstrapPageBytes) break;
    examined++;
    pageBytes += documentBytes;
    for (const { row, bytes } of encoded) {
      if (size + bytes > bootstrapChunkBytes) {
        chunks.push(`[${rows.join(',')}]`);
        rows = [];
        size = 2;
      }
      rows.push(row);
      size += bytes;
    }
  }
  if (rows.length) chunks.push(`[${rows.join(',')}]`);
  return { chunks, examined };
}

function prepareAutomaticHandoff(rows: BootstrapInput[], sourceCutoff: Timestamp) {
  const cutoff = sourceCutoff.toMillis();
  const latestClosedWeek = readingRollupWeekForDay(date(cutoff - 8 * day - 9 * hour))!;
  const earliest = rows.reduce((min, { session }) => session.completionRoundNumber !== undefined ? min : Math.min(min,
    session.startedAtClient - session.timezoneOffsetMinutes * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS), cutoff);
  const firstReadingWeek = readingRollupWeekForDay(date(Math.max(0, earliest)))!;
  // A new account can leave the first unclosed week for Cron, but never stage it.
  const nextWeek = firstReadingWeek > latestClosedWeek
    ? date(parseReadingRollupMonday(latestClosedWeek) + week)
    : latestClosedWeek;
  const close = Timestamp.fromMillis(weeklyClose(nextWeek));
  const seedCutoff = sourceCutoff < close ? sourceCutoff : close;
  const sessions = rows.filter(({ firstReceivedAt }) => !firstReceivedAt
    || compareReadingUploadTimes(firstReceivedAt, seedCutoff) <= 0).map(({ session }) => session);
  const end = parseReadingRollupMonday(nextWeek);
  const span = Math.max(1, (end - parseReadingRollupMonday(firstReadingWeek)) / week + 1);
  const count = READING_CALENDAR_WEEK_COUNT * Math.ceil(span / READING_CALENDAR_WEEK_COUNT) - 1;
  if (count + (count + 1) / READING_CALENDAR_WEEK_COUNT + 2 > 500) {
    throw new InvalidRollupInput('bootstrap-publication-too-large');
  }
  const firstWeek = date(end - count * week);
  const weeks = Array.from({ length: count }, (_, index) => {
    const start = date(end - (count - index) * week);
    return computeWeeklyReadingRollup(selectWeeklyReadingRollupInputs(sessions, start), start);
  });
  return {
    weeks, nextWeek, sourceCutoff: seedCutoff, carry: createReadingRollupCarry(sessions, nextWeek), pilotTuesday: false,
    coversHistoryStart: rollupCoversHistoryStart(sessions, firstWeek),
    coversDaySource: true, evidenceCompatible: sessions.every((session) => session.completionRoundNumber === undefined),
  };
}

async function prepareReadingRollup(db: Firestore, lease: Lease, ref: DocumentReference, progress: RollupBootstrap,
  stopAt: number, now: () => number, maxPages: number, metrics: RollupSourceMetrics) {
  validateBootstrapCheckpoint(progress);
  let bootstrap = progress;
  const ordered = sourceRef(db, lease.uid).orderBy(FieldPath.documentId());
  for (let pages = 0; !bootstrap.daysScanned && now() < stopAt && pages < maxPages; pages++) {
    const scanDays = bootstrap.scanned;
    const limit = await reserveReadingRollupReads(db, lease, scanDays ? dayPageSize : pageSize, now);
    if (!limit) return 'budget';
    const page = scanDays
      ? await getRollupDayPage(db, lease.uid, Timestamp.fromMillis(0), bootstrap.cutoff!, bootstrap.dayCursor, limit)
      : await (bootstrap.cursor ? ordered.startAfter(bootstrap.cursor) : ordered).limit(limit).get();
    const cutoff = bootstrap.cutoff ?? page.readTime;
    metrics[scanDays ? 'dayDocuments' : 'legacyDocuments'] += page.size;
    const { chunks, examined } = encodeBootstrapPage(page.docs, (doc) => {
      if (scanDays) return rollupDayRows(doc, undefined, cutoff, metrics);
      const value = doc.data();
      const received = value.uploadedAtServer;
      if (doc.createTime > cutoff || doc.updateTime > cutoff || !isReadingSessionV1(value) || value.sessionId !== doc.id) return [];
      const session = toReadingSessionPayload(value);
      // Old imports have no receipt and cannot be replayed by the timestamp-based tail.
      return received instanceof Timestamp
        ? [{ session, firstReceivedAt: { seconds: received.seconds, nanoseconds: received.nanoseconds } }]
        : [{ session }];
    });
    const start = bootstrap.chunks;
    const bytes = bootstrap.bytes + chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
    if (start + chunks.length > maxBootstrapChunks || bytes > maxBootstrapInputBytes) {
      throw new InvalidRollupInput('bootstrap-source-too-large');
    }
    const last = page.docs[examined - 1];
    const scanned = examined === page.size && page.size < limit;
    bootstrap = scanDays
      ? { ...bootstrap, chunks: start + chunks.length, bytes, daysScanned: scanned,
        dayCursor: last ? dayCursor(last) : bootstrap.dayCursor ?? null }
      : { ...bootstrap, cutoff, cursor: last?.id ?? bootstrap.cursor, chunks: start + chunks.length, bytes, scanned };
    await saveRollupJob(db, lease, now, (tx) => {
      chunks.forEach((payload, index) => tx.create(bootstrapChunk(ref, start + index), { payload }));
      tx.update(ref, { bootstrap });
    });
  }
  if (!bootstrap.daysScanned || now() >= stopAt) return 'pending';
  if (!bootstrap.chunks) {
    // The discovered source can be removed administratively before enrollment starts.
    await saveRollupJob(db, lease, now, (tx) => tx.delete(ref));
    return 'empty';
  }
  const sessions = new Map<string, ReturnType<typeof readBootstrapChunk>[number]>();
  for (let start = 0; start < bootstrap.chunks; start += 20) {
    if (now() >= stopAt) return 'pending';
    const count = Math.min(20, bootstrap.chunks - start);
    const pages = await db.getAll(...Array.from({ length: count }, (_, i) => bootstrapChunk(ref, start + i)));
    for (const page of pages) {
      if (!page.exists) throw new InvalidRollupInput('missing-bootstrap-page');
      for (const row of readBootstrapChunk(page.get('payload'))) {
        const existing = sessions.get(row.session.sessionId);
        if (existing && !sameReadingSessionPayload(existing.session, row.session)) throw new InvalidRollupInput('conflicting-bootstrap-input');
        sessions.set(row.session.sessionId, row);
      }
    }
  }
  if (now() >= stopAt) return 'pending';
  metrics.inputSessions += sessions.size;
  for (const { session } of sessions.values()) metrics.inputIntervals += session.activeIntervals?.length ?? 1;
  await stageReadingRollupHandoff(db, lease, prepareAutomaticHandoff([...sessions.values()], bootstrap.cutoff!), now, bootstrap.chunks);
  return 'prepared';
}

async function clearReadingRollupBootstrap(db: Firestore, lease: Lease, ref: DocumentReference, remaining: number,
  stopAt: number, now: () => number) {
  // Keep each cleanup transaction below the size limit even with full chunks.
  while (remaining > 0 && now() < stopAt) {
    const end = remaining;
    remaining = Math.max(0, end - 10);
    await saveRollupJob(db, lease, now, (tx) => {
      for (let index = remaining; index < end; index++) tx.delete(bootstrapChunk(ref, index));
      tx.update(ref, { bootstrapCleanup: remaining || FieldValue.delete() });
    });
  }
}

async function closeReadingRollup(db: Firestore, lease: Lease, stopAt: number, now: () => number, maxPages: number,
  metrics: RollupSourceMetrics) {
  const ref = jobs(db).doc(lease.uid);
  const snapshot = await ref.get();
  if (snapshot.get('blocked') || !((snapshot.get('dueAt') ?? snapshot.get('bootstrapDueAt')) <= now())) return 'skipped';
  try {
    const bootstrap: RollupBootstrap | undefined = snapshot.get('bootstrap');
    if (bootstrap !== undefined) return await prepareReadingRollup(db, lease, ref, bootstrap, stopAt, now, maxPages, metrics);
    const saved = snapshot.get('payload') as string;
    let job = readJobPayload(saved);
    if (new Timestamp(...job.closeAt).valueOf() > Timestamp.fromMillis(now()).valueOf()) return 'skipped';
    const cleanup: number | undefined = snapshot.get('bootstrapCleanup');
    if (cleanup) await clearReadingRollupBootstrap(db, lease, ref, cleanup, stopAt, now);
    const source = sourceRef(db, lease.uid);
    if (job.tailPolicy !== 2) {
      if (job.cursor || job.scanned) {
        const baseline = job.closedAllocation;
        if (!baseline || !Number.isSafeInteger(baseline.sessionCount)
          || baseline.sessionCount < 0 || baseline.sessionCount > job.carry.sessions.length) {
          throw new InvalidRollupInput('unverified-closed-week-checkpoint');
        }
        job.carry = { ...job.carry, sessions: job.carry.sessions.slice(0, baseline.sessionCount) };
        const ids = new Set(job.carry.sessions.map(({ sessionId }) => sessionId));
        if (closedReadingAllocationDigest(job.carry, job.nextWeek, ids) !== baseline.digest) {
          throw new InvalidRollupInput('unverified-closed-week-checkpoint');
        }
        delete job.closedAllocation;
        job.cursor = null;
        job.scanned = false;
      }
      job.tailPolicy = 2;
    }
    const protectedCount = job.closedAllocation?.sessionCount ?? job.carry.sessions.length;
    const protectedIds = new Set(job.carry.sessions.slice(0, protectedCount).map(({ sessionId }) => sessionId));
    const digest = closedReadingAllocationDigest(sortReadingRollupCarry(job.carry), job.nextWeek, protectedIds);
    if (job.closedAllocation && job.closedAllocation.digest !== digest) {
      throw new InvalidRollupInput('changed-closed-week-allocation');
    }
    job.closedAllocation ??= { sessionCount: protectedCount, digest };
    const openDay = parseReadingRollupMonday(job.nextWeek);
    const point = { lastDay: date(openDay - day), sampleFloor: job.carry.sampleFloor };
    const handoffStamp = job.handoffSourceThrough ?? job.evidenceSeedThrough;
    const handoffCutoff = handoffStamp && new Timestamp(...handoffStamp);
    const through = new Timestamp(...job.closeAt);
    const after = new Timestamp(...job.sourceAfter);
    const dayAfter = job.dayHandoffThrough ? new Timestamp(...job.dayHandoffThrough) : after;
    job.dayScan ??= { cursor: null, scanned: false, pending: [] };
    let spilled: ReadingDayEntry[] | null = null;
    const complete = () => job.scanned && job.dayScan?.scanned
      && (spilled?.length ?? (job.dayScan.spillCount || job.dayScan.pending.length)) === 0 && !job.dayScan.legacyPending?.length;
    const saveCheckpoint = async (spill: string[] = [], spillStart = 0) => {
      const checkpoint = jobPayload(job);
      await saveRollupJob(db, lease, now, (tx) => {
        spill.forEach((payload, offset) => tx.create(daySpillRef(ref, job.nextWeek, spillStart + offset), { payload }));
        tx.update(ref, { payload: checkpoint });
      });
      metrics.weeklyCheckpointWrites++;
      metrics.daySpillWrites += spill.length;
    };
    for (let pages = 0; !complete() && now() < stopAt && pages < maxPages; pages++) {
      const days: DayScan = job.dayScan;
      if (!days.scanned) {
        const limit = await reserveReadingRollupReads(db, lease, dayPageSize, now);
        if (!limit) return 'budget';
        const page = await getRollupDayPage(db, lease.uid, dayAfter, through, days.cursor, limit);
        metrics.dayDocuments += page.size;
        job.dayScan = collectDayScanPage(days, page.docs, dayAfter, through, limit, metrics);
        // An existing in-progress checkpoint may have consumed only v1.
        if (job.dayScan.scanned && (job.dayScan.pending.length || job.dayScan.spillCount) && (job.cursor || job.scanned)) {
          job.carry = { ...job.carry, sessions: job.carry.sessions.slice(0, protectedCount) };
          job.scanned = false;
          job.cursor = null;
        }
        const start = job.dayScan.spillCount ?? 0;
        await saveCheckpoint(spillDayInputs(job.dayScan), start);
        continue;
      }
      if (days.spillCount && spilled === null) {
        spilled = await readSpilledDayInputs(db, ref, job, days, stopAt, now, metrics);
        if (!spilled) return 'pending';
      }
      let rows = takeRollupInputRows(job, days, spilled);
      if (!rows.length && !job.scanned) {
        const limit = await reserveReadingRollupReads(db, lease, pageSize, now);
        if (!limit) return 'budget';
        const ordered = source.where('uploadedAtServer', '>', after).where('uploadedAtServer', '<=', through)
          .orderBy('uploadedAtServer').orderBy(FieldPath.documentId());
        const page = await (job.cursor ? ordered.startAfter(new Timestamp(...job.cursor.time), job.cursor.id) : ordered).limit(limit).get();
        metrics.legacyDocuments += page.size;
        days.legacyPending = [];
        for (const doc of page.docs) {
          const data = doc.data();
          const receivedAt = data.uploadedAtServer;
          if (receivedAt instanceof Timestamp && isReadingSessionV1(data) && data.sessionId === doc.id
            && (!handoffCutoff || doc.createTime > handoffCutoff || doc.updateTime > handoffCutoff)) {
            days.legacyPending.push({
              firstReceivedAt: { seconds: receivedAt.seconds, nanoseconds: receivedAt.nanoseconds },
              session: toReadingSessionPayload(data),
            });
          }
        }
        const last = page.docs.at(-1);
        if (last) {
          const at = last.get('uploadedAtServer') as Timestamp;
          job.cursor = { time: stamp(at), id: last.id };
        }
        job.scanned = page.size < limit;
        rows = takeRollupInputRows(job, days, spilled);
      }
      const retainedIds = new Set(job.carry.sessions.map(({ sessionId }) => sessionId));
      metrics.inputSessions += rows.length;
      for (const { session } of rows) metrics.inputIntervals += session.activeIntervals?.length ?? 1;
      try {
        const incoming = rows.map(({ session }) => session).filter(({ sessionId }) => !retainedIds.has(sessionId));
        const eligible = selectReadingRollupTail(point, job.carry.sessions, incoming);
        job.carry = addReadingRollupPageWithoutChangingClosedWeek(job.carry, eligible, job.nextWeek, protectedIds, digest);
      }
      catch (error) {
        if (error instanceof RangeError) throw new InvalidRollupInput('unsupported-source-boundary');
        throw error;
      }
      await saveCheckpoint();
    }
    if (!complete() || now() >= stopAt) return 'pending';

    const closed = job.nextWeek;
    const carry = sortReadingRollupCarry(job.carry);
    if (closedReadingAllocationDigest(carry, closed, protectedIds) !== job.closedAllocation.digest) {
      throw new InvalidRollupInput('changed-closed-week-allocation');
    }
    const detail = computeWeeklyReadingRollup(selectWeeklyReadingRollupInputs(carry.sessions, closed), closed);
    const detailPayload = payload(detail, 256);
    const group = [...job.group, { weekStart: closed, days: detail.days }];
    const calendarPayload = group.length === READING_CALENDAR_WEEK_COUNT ? payload(computeReadingCalendarRollup(group), 128) : null;
    const nextWeek = date(Date.parse(closed) + week);
    const nextCloseTime = weeklyClose(nextWeek);
    const previousClose = new Timestamp(...job.closeAt);
    const nextClose = Timestamp.fromMillis(nextCloseTime);
    const spills = job.dayScan?.spillCount ?? 0;
    delete job.evidenceSeedThrough;
    delete job.handoffSourceThrough;
    delete job.dayHandoffThrough;
    delete job.dayScan;
    delete job.closedAllocation;
    job = {
      ...job, nextWeek, sourceAfter: job.closeAt, cursor: null, scanned: false,
      closeAt: nextClose.valueOf() > previousClose.valueOf() ? stamp(nextClose) : job.closeAt,
      carry: createReadingRollupCarry(carry.sessions, nextWeek),
      group: calendarPayload ? [] : group, lastCalendarWeek: calendarPayload ? closed : job.lastCalendarWeek,
    };
    const next = jobPayload(job);
    const previousFiles = await fileTotalsRef(ref).get();
    const previousWeek = date(Date.parse(closed) - week);
    const prior = previousFiles.get('throughWeek') === previousWeek ? parseFilePayload(previousFiles.get('payload')) : null;
    const files = prior
      ? rollupFilePayload(mergeReadingFileRollups(prior.files, detail.files),
        prior.books && mergeReadingReportBooks(prior.books, summarizeReadingReportBooks(detail.activities)),
        job.coversHistoryStart ? job.carry : undefined, job.evidenceCompatible)
      : null;
    // Readers only ever see a manifest committed with its complete artifacts.
    await saveRollupJob(db, lease, now, (tx) => {
      if (spills) tx.create(dayCleanupQueue(db).doc(dayCleanupJobId(lease.uid, closed)), {
        uid: lease.uid, week: closed, remaining: spills,
      });
      tx.create(ref.collection('readingStatsRollupWeeksV1').doc(closed), { payload: detailPayload });
      if (calendarPayload) tx.create(ref.collection('readingStatsRollupCalendarsV1').doc(closed), { payload: calendarPayload });
      if (files) tx.set(fileTotalsRef(ref), { throughWeek: closed, payload: files });
      tx.set(ref.collection('readingStatsRollupManifestsV1').doc('current'), {
        schemaVersion: 1, firstWeek: job.firstWeek, publishedThroughWeek: closed,
        sourceThrough: previousClose, lastCalendarWeek: job.lastCalendarWeek,
        calendarTail: job.group,
        coversHistoryStart: job.coversHistoryStart === true,
      });
      tx.update(ref, { payload: next, dueAt: queueOrder(nextCloseTime, accountHash(lease.uid)) });
    });
    return 'published';
  } catch (error) {
    if (!(error instanceof InvalidRollupInput)) throw error;
    await saveRollupJob(db, lease, now, (tx) => tx.update(ref, {
      blocked: error.message, dueAt: FieldValue.delete(), bootstrapDueAt: FieldValue.delete(),
    }));
    return 'blocked';
  }
}

export async function runReadingRollupCron(db: Firestore, { now = Date.now, runForMs = 40_000, listAccounts, reportQueue }: {
  now?: () => number;
  runForMs?: number;
  listAccounts?: ListRollupAccounts;
  reportQueue?: (metrics: RollupSourceMetrics & {
    oldestDueMs?: number; oldestBootstrapDueMs?: number; regularVisited: number; bootstrapVisited: number; elapsedMs?: number;
  }) => void;
} = {}) {
  const startedAt = now();
  const stopAt = startedAt + runForMs;
  const workStopAt = stopAt - Math.min(2_000, Math.floor(runForMs / 10));
  const bootstrapReserve = Math.min(6_000, Math.floor(runForMs / 5));
  const enrollmentReserve = listAccounts ? Math.min(2_000, Math.floor(runForMs / 10)) : 0;
  const outcomes: Record<string, number> = {};
  type DueField = 'dueAt' | 'bootstrapDueAt';
  const visited = new Set<string>();
  const deferred: { id: string; field: DueField }[] = [];
  const metrics: Parameters<NonNullable<typeof reportQueue>>[0] = {
    regularVisited: 0, bootstrapVisited: 0, legacyDocuments: 0, dayDocuments: 0,
    inputSessions: 0, inputIntervals: 0, quarantinedDayDocuments: 0,
    daySpillReads: 0, daySpillWrites: 0, weeklyCheckpointWrites: 0, dayCleanupDocuments: 0, dayCleanupFailures: 0,
  };
  const reportFailure = (stage: string, error: unknown) => {
    console.error('[reading-rollup]', stage, error instanceof Error ? error.name : 'unknown');
  };
  const runJob = async (id: string, field: DueField, deadline: number) => {
    let lease: Lease | null = null;
    let status: string | undefined;
    try {
      lease = await claimReadingRollup(db, id, now);
      if (lease) status = await closeReadingRollup(db, lease, deadline, now, sourcePagesPerTurn, metrics);
    } catch (error) {
      reportFailure('scheduled job failed', error);
      status = 'failed';
      if (lease) {
        const claimed = lease;
        try {
          await saveRollupJob(db, claimed, now, tx => tx.update(jobs(db).doc(id), { [field]: now() + retryDelay }));
        } catch (retryError) {
          reportFailure('could not postpone failed job', retryError);
        }
      }
    } finally {
      if (lease) {
        try { await releaseReadingRollup(db, lease); }
        catch (error) {
          reportFailure('could not release job lease', error);
          outcomes.failed = (outcomes.failed ?? 0) + 1;
        }
      }
    }
    if (status) outcomes[status] = (outcomes[status] ?? 0) + 1;
    return status;
  };
  const runDue = async (field: DueField, maxJobs: number, deadline: number) => {
    const query = jobs(db).where(field, '<=', startedAt).orderBy(field).select(field);
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    while (scanned < maxJobs && now() < deadline && !outcomes.budget) {
      const limit = Math.min(6, maxJobs - scanned);
      const page = await (cursor ? query.startAfter(cursor) : query).limit(limit).get();
      if (!cursor && page.docs.length) {
        metrics[field === 'dueAt' ? 'oldestDueMs' : 'oldestBootstrapDueMs'] = Math.max(0, startedAt - page.docs[0].get(field));
      }
      for (const doc of page.docs) {
        if (now() >= deadline || outcomes.budget) break;
        if (visited.has(doc.id)) continue;
        visited.add(doc.id);
        metrics[field === 'dueAt' ? 'regularVisited' : 'bootstrapVisited']++;
        if (await runJob(doc.id, field, deadline) === 'pending') deferred.push({ id: doc.id, field });
      }
      scanned += page.docs.length;
      if (page.docs.length < limit) break;
      cursor = page.docs.at(-1);
    }
  };

  await runDue('dueAt', 64, workStopAt - bootstrapReserve);
  await runDue('bootstrapDueAt', 16, workStopAt - enrollmentReserve);
  if (listAccounts && now() < workStopAt && !outcomes.budget) {
    try {
      const enrolled = await enrollReadingRollupAccounts(db, listAccounts, workStopAt, now);
      if (enrolled) outcomes.enrolled = enrolled;
    } catch (error) {
      console.error('[reading-rollup] account discovery failed', error instanceof Error ? error.name : 'unknown');
      outcomes.failed = (outcomes.failed ?? 0) + 1;
    }
  }
  // With no other work waiting, one account can still use the full daily budget.
  // Each additional turn is bounded so other unfinished accounts get a chance.
  for (let turn = 1; turn < Math.ceil(dailySourceReads / (sourcePagesPerTurn * pageSize))
    && deferred.length && now() < workStopAt && !outcomes.budget; turn++) {
    for (const { id, field } of deferred.splice(0)) {
      if (now() >= workStopAt || outcomes.budget) break;
      if (--outcomes.pending === 0) delete outcomes.pending;
      const status = await runJob(id, field, workStopAt);
      if (status === 'pending') deferred.push({ id, field });
      else if (status === undefined) outcomes.pending = (outcomes.pending ?? 0) + 1;
    }
  }
  if (now() < stopAt) {
    try {
      const queued = await dayCleanupQueue(db).orderBy(FieldPath.documentId()).limit(dayCleanupBatchLimit).get();
      const tasks = queued.docs.map(({ ref }) => ref);
      for (let batch = 0; batch < dayCleanupBatchLimit && tasks.length && now() < stopAt; batch++) {
        const task = tasks.shift()!;
        try {
          const { deleted, remaining } = await cleanPublishedDayChunks(db, task);
          metrics.dayCleanupDocuments += deleted;
          if (remaining) tasks.push(task);
        } catch (error) {
          metrics.dayCleanupFailures++;
          reportFailure('day chunk cleanup failed', error);
        }
      }
    } catch (error) {
      metrics.dayCleanupFailures++;
      reportFailure('day chunk cleanup queue failed', error);
    }
  }
  reportQueue?.({ ...metrics, elapsedMs: now() - startedAt });
  return outcomes;
}
