import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  FieldPath, FieldValue, Timestamp, type DocumentReference, type Firestore, type QueryDocumentSnapshot, type Transaction,
} from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity.ts';
import {
  isReadingSessionV1, READING_SESSION_MAX_CLOCK_OFFSET_MS, toReadingSessionPayload, type ReadingSessionV1,
} from '../lib/readingStatistics.ts';
import { mergeReadingReportBooks, parseReadingReportBooks, summarizeReadingReportBooks, type ReadingReportBook } from '../lib/readingStatisticsReport.ts';
import {
  computeReadingCalendarRollup, computeWeeklyReadingRollup, isReadingRollupHandoffWeekCount, parseReadingRollupMonday, READING_CALENDAR_WEEK_COUNT,
  mergeReadingFileRollups, parseReadingFileRollups, readingRollupWeekForDay, selectWeeklyReadingRollupInputs,
  type ReadingFileRollup, type WeeklyReadingRollup,
} from '../lib/readingStatisticsRollup.ts';
import {
  addReadingRollupPage, closedReadingAllocationDigest, createReadingRollupCarry, rollupCanUseFileEvidence,
  rollupCoversHistoryStart, sortReadingRollupCarry, type ReadingRollupCarry,
} from './readingRollupInputs.ts';

const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * day;
const leaseDuration = 5 * 60_000;
const dailySourceReads = 4_000;
const pageSize = 100;
const maxJobPayloadBytes = 512 * 1024;
const maxDecodedCarryBytes = 8 * 1024 * 1024;
const enrollmentPageSize = 20;
const bootstrapChunkBytes = 512 * 1024;
const maxBootstrapPageBytes = 8 * 1024 * 1024;
const maxBootstrapChunks = 256;
const maxBootstrapInputBytes = 32 * 1024 * 1024;
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const root = `artifacts/${APP_ID}`;
const jobs = (db: Firestore) => db.collection(`${root}/readingStatsRollupJobsV1`);
const leaseRef = (db: Firestore, uid: string) => db.doc(`${root}/readingStatsRollupLeasesV1/${uid}`);
const sourceRef = (db: Firestore, uid: string) => db.collection(`${root}/users/${uid}/libraries/local/readingStatsV1`);
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const stamp = (time: Timestamp) => [time.seconds, time.nanoseconds] as const;
type Stamp = ReturnType<typeof stamp>;
type Cursor = { time: Stamp; id: string };
type WeekSummary = Pick<WeeklyReadingRollup, 'weekStart' | 'days'>;
type Job = {
  firstWeek: string;
  nextWeek: string;
  sourceAfter: Stamp;
  closeAt: Stamp;
  cursor: Cursor | null;
  scanned: boolean;
  carry: ReadingRollupCarry;
  closedAllocation?: { sessionCount: number; digest: string };
  group: WeekSummary[];
  lastCalendarWeek: string | null;
  coversHistoryStart?: boolean;
  evidenceCompatible?: boolean;
  evidenceSeedThrough?: Stamp;
};
type PersistedJob = Omit<Job, 'carry'> & {
  carry: ReadingRollupCarry | { encoding: 'gzip-v1'; data: string };
};

type Lease = { uid: string; token: string };
type RollupBootstrap = { cutoff: Timestamp | null; cursor: string | null; chunks: number; bytes: number; scanned: boolean };
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

  const carry = Buffer.from(JSON.stringify(job.carry));
  if (carry.length > maxDecodedCarryBytes) throw new InvalidRollupInput('rollup-payload-too-large');
  return payload({ ...job, carry: { encoding: 'gzip-v1', data: gzipSync(carry).toString('base64') } }, maxJobPayloadBytes / 1024);
}

function readJobPayload(payload: string): Job {
  const job = JSON.parse(payload) as PersistedJob;
  if (!('encoding' in job.carry)) return { ...job, carry: job.carry };

  if (job.carry.encoding !== 'gzip-v1' || Buffer.byteLength(payload) > maxJobPayloadBytes) {
    throw new Error('Unsupported reading rollup checkpoint.');
  }
  const json = gunzipSync(Buffer.from(job.carry.data, 'base64'), { maxOutputLength: maxDecodedCarryBytes });
  const carry = JSON.parse(json.toString('utf8')) as ReadingRollupCarry;
  if (!Number.isSafeInteger(carry.sampleFloor) || !Array.isArray(carry.sessions)) {
    throw new Error('Invalid reading rollup checkpoint.');
  }
  return { ...job, carry };
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
      if (!bootstrap?.scanned || bootstrap.chunks !== bootstrapChunks) throw new Error('Reading rollup bootstrap changed.');
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
  const found = (await Promise.all(candidates.slice(0, allowed).map(async ({ ref }) =>
    (await sourceRef(db, ref.id).limit(1).select().get()).empty ? null : ref,
  ))).filter((ref) => ref !== null);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(state);
    if (snapshot.get('pageToken') !== cursor || snapshot.get('scannedDay') === today) return 0;
    const existing = found.length ? await tx.getAll(...found, { fieldMask: ['dueAt'] }) : [];
    const newJobs = existing.filter((doc) => !doc.exists);
    for (const { ref } of newJobs) {
      const bootstrap: RollupBootstrap = { cutoff: null, cursor: null, chunks: 0, bytes: 0, scanned: false };
      tx.create(ref, { bootstrap, bootstrapDueAt: now() });
    }
    if (allowed === candidates.length) {
      tx.set(state, { scannedDay: today, ...(pageToken ? { pageToken } : {}) });
    }
    return newJobs.length;
  });
}

const bootstrapChunk = (ref: DocumentReference, index: number) => (
  ref.collection('readingStatsRollupBootstrapChunksV1').doc(String(index))
);

function encodeBootstrapPage(documents: readonly QueryDocumentSnapshot[], cutoff: Timestamp) {
  const chunks: string[] = [];
  let rows: string[] = [];
  let size = 2;
  let examined = 0;
  let pageBytes = 0;
  for (const doc of documents) {
    if (doc.createTime > cutoff) {
      examined++;
      continue;
    }
    const value = doc.data();
    if (doc.updateTime > cutoff || !isReadingSessionV1(value) || value.sessionId !== doc.id) {
      throw new InvalidRollupInput('invalid-bootstrap-source-session');
    }
    const row = JSON.stringify(toReadingSessionPayload(value));
    const bytes = Buffer.byteLength(row) + 1;
    if (bytes + 2 > bootstrapChunkBytes) throw new InvalidRollupInput('bootstrap-source-too-large');
    // Leave a Firestore request-size margin for chunk boundaries and metadata.
    if (pageBytes + bytes > maxBootstrapPageBytes) break;
    examined++;
    pageBytes += bytes;
    if (size + bytes > bootstrapChunkBytes) {
      chunks.push(`[${rows.join(',')}]`);
      rows = [];
      size = 2;
    }
    rows.push(row);
    size += bytes;
  }
  if (rows.length) chunks.push(`[${rows.join(',')}]`);
  return { chunks, examined };
}

function prepareAutomaticHandoff(sessions: ReadingSessionV1[], sourceCutoff: Timestamp) {
  const cutoff = sourceCutoff.toMillis();
  const latestClosedWeek = readingRollupWeekForDay(date(cutoff - 8 * day - 9 * hour))!;
  const earliest = sessions.reduce((min, session) => session.completionRoundNumber !== undefined ? min : Math.min(min,
    session.startedAtClient - session.timezoneOffsetMinutes * 60_000 - READING_SESSION_MAX_CLOCK_OFFSET_MS), cutoff);
  const firstReadingWeek = readingRollupWeekForDay(date(Math.max(0, earliest)))!;
  // A new account can leave the first unclosed week for Cron, but never stage it.
  const nextWeek = firstReadingWeek > latestClosedWeek
    ? date(parseReadingRollupMonday(latestClosedWeek) + week)
    : latestClosedWeek;
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
    weeks, nextWeek, sourceCutoff, carry: createReadingRollupCarry(sessions, nextWeek), pilotTuesday: false,
    coversHistoryStart: rollupCoversHistoryStart(sessions, firstWeek),
    evidenceCompatible: sessions.every((session) => session.completionRoundNumber === undefined),
  };
}

async function prepareReadingRollup(db: Firestore, lease: Lease, ref: DocumentReference, progress: RollupBootstrap,
  stopAt: number, now: () => number) {
  let bootstrap = progress;
  const ordered = sourceRef(db, lease.uid).orderBy(FieldPath.documentId());
  while (!bootstrap.scanned && now() < stopAt) {
    const limit = await reserveReadingRollupReads(db, lease, pageSize, now);
    if (!limit) return 'budget';
    const page = await (bootstrap.cursor ? ordered.startAfter(bootstrap.cursor) : ordered).limit(limit).get();
    const cutoff = bootstrap.cutoff ?? page.readTime;
    const { chunks, examined } = encodeBootstrapPage(page.docs, cutoff);
    const start = bootstrap.chunks;
    const bytes = bootstrap.bytes + chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk), 0);
    if (start + chunks.length > maxBootstrapChunks || bytes > maxBootstrapInputBytes) {
      throw new InvalidRollupInput('bootstrap-source-too-large');
    }
    bootstrap = {
      cutoff, cursor: page.docs[examined - 1]?.id ?? bootstrap.cursor,
      chunks: start + chunks.length, bytes, scanned: examined === page.size && page.size < limit,
    };
    await saveRollupJob(db, lease, now, (tx) => {
      chunks.forEach((payload, index) => tx.create(bootstrapChunk(ref, start + index), { payload }));
      tx.update(ref, { bootstrap });
    });
  }
  if (!bootstrap.scanned || now() >= stopAt) return 'pending';
  if (!bootstrap.chunks) {
    // The discovered source can be removed administratively before enrollment starts.
    await saveRollupJob(db, lease, now, (tx) => tx.delete(ref));
    return 'empty';
  }
  const sessions: ReadingSessionV1[] = [];
  for (let start = 0; start < bootstrap.chunks; start += 20) {
    if (now() >= stopAt) return 'pending';
    const count = Math.min(20, bootstrap.chunks - start);
    const pages = await db.getAll(...Array.from({ length: count }, (_, i) => bootstrapChunk(ref, start + i)));
    for (const page of pages) {
      if (!page.exists) throw new InvalidRollupInput('missing-bootstrap-page');
      sessions.push(...JSON.parse(page.get('payload')));
    }
  }
  if (now() >= stopAt) return 'pending';
  await stageReadingRollupHandoff(db, lease, prepareAutomaticHandoff(sessions, bootstrap.cutoff!), now, bootstrap.chunks);
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

async function closeReadingRollup(db: Firestore, lease: Lease, stopAt: number, now: () => number) {
  const ref = jobs(db).doc(lease.uid);
  const snapshot = await ref.get();
  if (!((snapshot.get('dueAt') ?? snapshot.get('bootstrapDueAt')) <= now())) return 'skipped';
  try {
    const bootstrap: RollupBootstrap | undefined = snapshot.get('bootstrap');
    if (bootstrap) return await prepareReadingRollup(db, lease, ref, bootstrap, stopAt, now);
    const saved = snapshot.get('payload') as string;
    if (!saved) return 'skipped';
    let job = readJobPayload(saved);
    if (new Timestamp(...job.closeAt).valueOf() > Timestamp.fromMillis(now()).valueOf()) return 'skipped';
    const cleanup: number | undefined = snapshot.get('bootstrapCleanup');
    if (cleanup) await clearReadingRollupBootstrap(db, lease, ref, cleanup, stopAt, now);
    const source = sourceRef(db, lease.uid);
    const protectedCount = job.closedAllocation?.sessionCount ?? job.carry.sessions.length;
    const protectedIds = new Set(job.carry.sessions.slice(0, protectedCount).map(({ sessionId }) => sessionId));
    // Older checkpoints already checked the allocation after every saved page.
    job.closedAllocation ??= {
      sessionCount: protectedCount,
      digest: closedReadingAllocationDigest(job.carry, job.nextWeek, protectedIds),
    };
    while (!job.scanned && now() < stopAt) {
      const limit = await reserveReadingRollupReads(db, lease, pageSize, now);
      if (limit === 0) return 'budget';
      const ordered = source.where('uploadedAtServer', '>', new Timestamp(...job.sourceAfter))
        .where('uploadedAtServer', '<=', new Timestamp(...job.closeAt))
        .orderBy('uploadedAtServer').orderBy(FieldPath.documentId());
      const page = await (job.cursor ? ordered.startAfter(new Timestamp(...job.cursor.time), job.cursor.id) : ordered).limit(limit).get();
      const sessions = page.docs.map((doc) => {
        const data = doc.data();
        if (!(data.uploadedAtServer instanceof Timestamp) || !isReadingSessionV1(data) || data.sessionId !== doc.id) {
          throw new InvalidRollupInput('invalid-source-session');
        }
        return toReadingSessionPayload(data);
      });
      try { job.carry = addReadingRollupPage(job.carry, sessions, job.nextWeek); }
      catch (error) {
        if (error instanceof RangeError) throw new InvalidRollupInput('unsupported-source-boundary');
        throw error;
      }
      if (job.coversHistoryStart && !rollupCoversHistoryStart(sessions, job.firstWeek)) job.coversHistoryStart = false;
      if (job.evidenceCompatible) {
        const seedThrough = job.evidenceSeedThrough && new Timestamp(...job.evidenceSeedThrough);
        const newSessions = seedThrough
          ? sessions.filter((_, index) => page.docs[index].get('uploadedAtServer') > seedThrough)
          : sessions;
        if (!rollupCanUseFileEvidence(newSessions, job.nextWeek)) job.evidenceCompatible = false;
      }
      const last = page.docs.at(-1);
      if (last) job.cursor = { time: stamp(last.get('uploadedAtServer')), id: last.id };
      job.scanned = page.size < limit;
      const checkpoint = jobPayload(job);
      await saveRollupJob(db, lease, now, (tx) => tx.update(ref, { payload: checkpoint }));
    }
    if (!job.scanned || now() >= stopAt) return 'pending';

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
    delete job.evidenceSeedThrough;
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

export async function runReadingRollupCron(db: Firestore, { now = Date.now, runForMs = 40_000, listAccounts }: {
  now?: () => number; runForMs?: number; listAccounts?: ListRollupAccounts;
} = {}) {
  const stopAt = now() + runForMs;
  const due = await jobs(db).where('dueAt', '<=', now()).orderBy('dueAt').limit(6).select('dueAt').get();
  const outcomes: Record<string, number> = {};
  const runDue = async (docs: readonly { id: string }[]) => {
    for (const doc of docs) {
      if (now() >= stopAt) break;
      const lease = await claimReadingRollup(db, doc.id, now);
      if (!lease) continue;
      let status = 'failed';
      try { status = await closeReadingRollup(db, lease, stopAt, now); }
      catch (error) { console.error('[reading-rollup] scheduled close failed', error instanceof Error ? error.name : 'unknown'); }
      finally { await releaseReadingRollup(db, lease); }
      outcomes[status] = (outcomes[status] ?? 0) + 1;
      if (status === 'budget') break;
    }
  };
  await runDue(due.docs);
  if (now() < stopAt && !outcomes.budget) {
    const bootstrapDue = await jobs(db).where('bootstrapDueAt', '<=', now()).orderBy('bootstrapDueAt')
      .limit(2).select('bootstrapDueAt').get();
    await runDue(bootstrapDue.docs);
  }
  if (listAccounts && now() < stopAt && !outcomes.budget) {
    try {
      const enrolled = await enrollReadingRollupAccounts(db, listAccounts, stopAt, now);
      if (enrolled) outcomes.enrolled = enrolled;
    } catch (error) {
      console.error('[reading-rollup] account discovery failed', error instanceof Error ? error.name : 'unknown');
      outcomes.failed = (outcomes.failed ?? 0) + 1;
    }
  }
  return outcomes;
}
