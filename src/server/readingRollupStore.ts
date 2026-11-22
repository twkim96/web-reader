import { createHash, randomUUID } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { APP_ID } from '../lib/appIdentity.ts';
import { isReadingSessionV1, toReadingSessionPayload } from '../lib/readingStatistics.ts';
import {
  computeReadingCalendarRollup, computeWeeklyReadingRollup, parseReadingRollupMonday,
  selectWeeklyReadingRollupInputs, type WeeklyReadingRollup,
} from '../lib/readingStatisticsRollup.ts';
import { addReadingRollupPage, createReadingRollupCarry, rollupCoversHistoryStart, type ReadingRollupCarry } from './readingRollupInputs.ts';

const hour = 3_600_000;
const day = 24 * hour;
const week = 7 * day;
const leaseDuration = 5 * 60_000;
const dailySourceReads = 2_000;
const pageSize = 100;
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
  slot: number;
  sourceAfter: Stamp;
  closeAt: Stamp;
  cursor: Cursor | null;
  scanned: boolean;
  carry: ReadingRollupCarry;
  group: WeekSummary[];
  lastCalendarWeek: string | null;
  coversHistoryStart?: boolean;
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

function dueAt(weekStart: string, slot: number) {
  // Monday at 18:00 KST precedes the end of Sunday at the largest westward offset.
  return parseReadingRollupMonday(weekStart) + week + Math.max(14 * hour, slot * day + 9 * hour);
}

function payload(value: unknown, maxKiB: number) {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxKiB * 1024) throw new InvalidRollupInput('rollup-payload-too-large');
  return json;
}

const jobPayload = (job: Job) => payload(job, 512);

/** Install nine unpublished weeks and the inputs for their first regular close. */
export async function stageReadingRollupHandoff(db: Firestore, lease: Lease, seed: {
  weeks: WeeklyReadingRollup[];
  nextWeek: string;
  sourceCutoff: Timestamp;
  carry: ReadingRollupCarry;
  pilotTuesday: boolean;
  coversHistoryStart?: boolean;
}, now = Date.now) {
  const { nextWeek, sourceCutoff, carry, pilotTuesday } = seed;
  const group = seed.weeks.map(({ weekStart, days }) => ({ weekStart, days }));
  computeReadingCalendarRollup([...group, { weekStart: nextWeek, days: [] }]);
  if (group.some(({ weekStart }, i) => group[0].weekStart !== date(Date.parse(weekStart) - i * week))
    || date(Date.parse(group.at(-1)!.weekStart) + week) !== nextWeek) throw new TypeError('Invalid rollup handoff order.');
  const slot = pilotTuesday ? 1 : createHash('sha256').update(lease.uid).digest().readUInt32BE() % 6;
  const due = dueAt(nextWeek, slot);
  const job: Job = {
    firstWeek: group[0].weekStart, nextWeek, slot, closeAt: stamp(Timestamp.fromMillis(due).valueOf() > sourceCutoff.valueOf()
      ? Timestamp.fromMillis(due) : sourceCutoff),
    // Replay one day at the seam because the Mac used document createTime and
    // regular uploads use uploadedAtServer. Session IDs make the replay idempotent.
    sourceAfter: stamp(Timestamp.fromMillis(sourceCutoff.toMillis() - day)), cursor: null, scanned: false,
    carry, group, lastCalendarWeek: null,
  };
  const ref = jobs(db).doc(lease.uid);
  const seedPayload = jobPayload(job);
  const proposed = seed.coversHistoryStart ? jobPayload({ ...job, coversHistoryStart: true }) : seedPayload;
  const weeks = seed.weeks.map((item) => ({ weekStart: item.weekStart, payload: payload(item, 256) }));
  const seedId = createHash('sha256').update(seedPayload).update(JSON.stringify(weeks)).digest('hex');
  return db.runTransaction(async (tx) => {
    await requireLease(db, tx, lease, now);
    const existing = await tx.get(ref);
    if (existing.exists) {
      if (existing.get('seedId') === seedId) return 'already-staged';
      throw new Error('A different reading rollup handoff already exists.');
    }
    for (const { weekStart, payload } of weeks) tx.create(ref.collection('readingStatsRollupWeeksV1').doc(weekStart), { payload });
    tx.create(ref, { payload: proposed, dueAt: due, seedId });
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
  let job = JSON.parse(saved) as Job;
  const source = db.collection(`${root}/users/${lease.uid}/libraries/local/readingStatsV1`);
  try {
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
      const last = page.docs.at(-1);
      if (last) job.cursor = { time: stamp(last.get('uploadedAtServer')), id: last.id };
      job.scanned = page.size < limit;
      const checkpoint = jobPayload(job);
      await saveRollupJob(db, lease, now, (tx) => tx.update(ref, { payload: checkpoint }));
    }
    if (!job.scanned || now() >= stopAt) return 'pending';

    const closed = job.nextWeek;
    const detail = computeWeeklyReadingRollup(selectWeeklyReadingRollupInputs(job.carry.sessions, closed), closed);
    const detailPayload = payload(detail, 256);
    const group = [...job.group, { weekStart: closed, days: detail.days }];
    const calendarPayload = group.length === 10 ? payload(computeReadingCalendarRollup(group), 128) : null;
    const nextWeek = date(Date.parse(closed) + week);
    const nextDue = dueAt(nextWeek, job.slot);
    const previousClose = new Timestamp(...job.closeAt);
    const nextClose = Timestamp.fromMillis(nextDue);
    job = {
      ...job, nextWeek, sourceAfter: job.closeAt, cursor: null, scanned: false,
      closeAt: nextClose.valueOf() > previousClose.valueOf() ? stamp(nextClose) : job.closeAt,
      carry: createReadingRollupCarry(job.carry.sessions, nextWeek),
      group: calendarPayload ? [] : group, lastCalendarWeek: calendarPayload ? closed : job.lastCalendarWeek,
    };
    const next = jobPayload(job);
    // Readers only ever see a manifest committed with its complete artifacts.
    await saveRollupJob(db, lease, now, (tx) => {
      tx.create(ref.collection('readingStatsRollupWeeksV1').doc(closed), { payload: detailPayload });
      if (calendarPayload) tx.create(ref.collection('readingStatsRollupCalendarsV1').doc(closed), { payload: calendarPayload });
      tx.set(ref.collection('readingStatsRollupManifestsV1').doc('current'), {
        schemaVersion: 1, firstWeek: job.firstWeek, publishedThroughWeek: closed,
        sourceThrough: previousClose, lastCalendarWeek: job.lastCalendarWeek,
        calendarTail: job.group,
        coversHistoryStart: job.coversHistoryStart === true,
      });
      tx.update(ref, { payload: next, dueAt: nextDue });
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
