import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { FieldPath, FieldValue, Timestamp, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity.ts';
import { isReadingSessionV1, toReadingSessionPayload } from '../lib/readingStatistics.ts';
import { mergeReadingReportBooks, parseReadingReportBooks, summarizeReadingReportBooks, type ReadingReportBook } from '../lib/readingStatisticsReport.ts';
import {
  computeReadingCalendarRollup, computeWeeklyReadingRollup, isReadingRollupHandoffWeekCount, parseReadingRollupMonday, READING_CALENDAR_WEEK_COUNT,
  mergeReadingFileRollups, parseReadingFileRollups, selectWeeklyReadingRollupInputs, type ReadingFileRollup, type WeeklyReadingRollup,
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
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const root = `artifacts/${APP_ID}`;
const jobs = (db: Firestore) => db.collection(`${root}/readingStatsRollupJobsV1`);
const leaseRef = (db: Firestore, uid: string) => db.doc(`${root}/readingStatsRollupLeasesV1/${uid}`);
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

export async function reserveReadingRollupReads(db: Firestore, lease: Lease, requested: number, now = Date.now) {
  if (!Number.isInteger(requested) || requested < 1 || requested > pageSize) throw new RangeError('Invalid source page size.');
  return db.runTransaction(async (tx) => {
    const ref = await requireLease(db, tx, lease, now);
    const current = now();
    const quotaDay = quotaDate.format(current);
    // Avoid reservations whose query window would straddle the quota reset.
    if (quotaDate.format(current + leaseDuration) !== quotaDay) return 0;
    const budget = db.doc(`${root}/readingStatsRollupBudgetsV1/${quotaDay}`);
    const reads = (await tx.get(budget)).get('sourceReads') ?? 0;
    const allowed = Math.max(0, Math.min(requested, dailySourceReads - reads));
    if (allowed > 0) {
      tx.set(budget, { sourceReads: reads + allowed });
      tx.update(ref, { expiresAt: current + leaseDuration });
    }
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
}, now = Date.now) {
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
    if (existing.exists) {
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
    tx.create(ref, { payload: proposed, dueAt: queueOrder(close, hash, pilotTuesday), seedId });
    return 'staged';
  });
}

async function saveRollupJob(db: Firestore, lease: Lease, now: () => number, write: (tx: Transaction) => void) {
  await db.runTransaction(async (tx) => {
    await requireLease(db, tx, lease, now);
    write(tx);
  });
}

async function closeReadingRollup(db: Firestore, lease: Lease, stopAt: number, now: () => number) {
  const ref = jobs(db).doc(lease.uid);
  const snapshot = await ref.get();
  const saved = snapshot.get('payload') as string;
  if (!saved || !(snapshot.get('dueAt') <= now())) return 'skipped';
  let job = readJobPayload(saved);
  if (new Timestamp(...job.closeAt).valueOf() > Timestamp.fromMillis(now()).valueOf()) return 'skipped';
  const source = db.collection(`${root}/users/${lease.uid}/libraries/local/readingStatsV1`);
  try {
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
    await saveRollupJob(db, lease, now, (tx) => tx.update(ref, { blocked: error.message, dueAt: FieldValue.delete() }));
    return 'blocked';
  }
}

export async function runReadingRollupCron(db: Firestore, { now = Date.now, runForMs = 40_000 } = {}) {
  const stopAt = now() + runForMs;
  const due = await jobs(db).where('dueAt', '<=', now()).orderBy('dueAt').limit(6).select('dueAt').get();
  const outcomes: Record<string, number> = {};
  for (const doc of due.docs) {
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
  return outcomes;
}
