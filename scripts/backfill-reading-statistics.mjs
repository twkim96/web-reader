import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { APP_ID } from '../src/lib/appIdentity.ts';
import {
  isReadingSessionV1,
  READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES,
  toReadingSessionPayload,
} from '../src/lib/readingStatistics.ts';
import {
  computeWeeklyReadingRollup,
  parseReadingRollupMonday,
  selectWeeklyReadingRollupInputs,
} from '../src/lib/readingStatisticsRollup.ts';

const weekMs = 7 * 86_400_000;
const pageLimit = 100;
const maxDraftBytes = 256 * 1024;
const quotaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Los_Angeles', dateStyle: 'short' });
const isoDate = (time) => new Date(time).toISOString().slice(0, 10);

export function openBackfillState(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS budgets (
      project TEXT NOT NULL, day TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0,
      weeks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project, day)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      project TEXT NOT NULL, uid TEXT NOT NULL, first_week TEXT NOT NULL, next_week TEXT NOT NULL,
      cutoff INTEGER, cursor TEXT, ingested INTEGER NOT NULL DEFAULT 0,
      cutoff_submillis INTEGER, blocked_document TEXT, blocked_reason TEXT,
      PRIMARY KEY(project, uid)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      project TEXT NOT NULL, uid TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(project, uid, id)
    );
    CREATE TABLE IF NOT EXISTS weeks (
      project TEXT NOT NULL, uid TEXT NOT NULL, week TEXT NOT NULL, cutoff INTEGER NOT NULL,
      cutoff_submillis INTEGER, payload TEXT NOT NULL, PRIMARY KEY(project, uid, week)
    );
  `);
  atomic(db, () => {
    const jobColumns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map(({ name }) => name));
    if (!jobColumns.has('cutoff_submillis')) db.exec('ALTER TABLE jobs ADD COLUMN cutoff_submillis INTEGER');
    if (!jobColumns.has('blocked_document')) db.exec('ALTER TABLE jobs ADD COLUMN blocked_document TEXT');
    if (!jobColumns.has('blocked_reason')) db.exec('ALTER TABLE jobs ADD COLUMN blocked_reason TEXT');
    const weekColumns = db.prepare('PRAGMA table_info(weeks)').all();
    if (!weekColumns.some(({ name }) => name === 'cutoff_submillis')) db.exec('ALTER TABLE weeks ADD COLUMN cutoff_submillis INTEGER');
  });
  return db;
}

function atomic(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readCutoff({ cutoff, cutoff_submillis: remainder }) {
  if (cutoff === null) return null;
  if (remainder === null) throw new Error('This job predates precise cutoffs. Preserve this database and use a new --state path.');
  const seconds = Math.floor(cutoff / 1000);
  return new Timestamp(seconds, (cutoff - seconds * 1000) * 1_000_000 + remainder);
}

/** Read only the fixed source generation; store a page and its cursor together. */
export async function stageReadingStatisticsBackfill(db, {
  project, uid, firstWeek, throughWeek, readPage, dailyReads = 1000, dailyWeeks = 5,
  currentTime = Date.now,
}) {
  const first = parseReadingRollupMonday(firstWeek);
  const through = parseReadingRollupMonday(throughWeek);
  const lastBoundary = through + weekMs + READING_SESSION_MAX_TIMEZONE_OFFSET_MINUTES * 60_000;
  if (first > through || lastBoundary > currentTime()) {
    throw new RangeError('Use a valid range of finished weeks.');
  }
  db.prepare('INSERT OR IGNORE INTO jobs(project, uid, first_week, next_week) VALUES (?, ?, ?, ?)').run(project, uid, firstWeek, firstWeek);
  const job = () => db.prepare('SELECT * FROM jobs WHERE project = ? AND uid = ?').get(project, uid);
  const initial = job();
  if (initial.first_week !== firstWeek) throw new Error('Resume using the original first week.');
  readCutoff(initial);
  if (initial.cutoff !== null && lastBoundary > initial.cutoff) {
    throw new Error('The requested week is outside this job’s fixed source cutoff.');
  }

  const getBudget = (day) => db.prepare('SELECT reads, weeks FROM budgets WHERE project = ? AND day = ?').get(project, day);
  const initBudget = (day) => db.prepare('INSERT OR IGNORE INTO budgets(project, day) VALUES (?, ?)').run(project, day);
  const startDay = quotaDate.format(currentTime());
  let stagedWeeks = 0;
  while (quotaDate.format(currentTime()) === startDay) {
    const state = job();
    if (state.ingested || state.blocked_reason) break;
    const reserved = atomic(db, () => {
      initBudget(startDay);
      const amount = Math.max(0, Math.min(pageLimit, dailyReads - getBudget(startDay).reads));
      db.prepare('UPDATE budgets SET reads = reads + ? WHERE project = ? AND day = ?').run(amount, project, startDay);
      return amount;
    });
    if (reserved === 0) break;
    // Reservations are conservative, including when the final or failed page is shorter.
    const { documents, readTime } = await readPage(state.cursor, reserved);
    const cutoff = readCutoff(state) ?? readTime;
    if (!(cutoff instanceof Timestamp) || lastBoundary > cutoff.toMillis()) {
      throw new Error('The server cutoff does not cover the requested finished weeks.');
    }
    const accepted = documents.filter(({ createdAt }) => createdAt.valueOf() <= cutoff.valueOf());
    const staged = atomic(db, () => {
      const current = job();
      if (current.blocked_reason) return false;
      if (current.cursor !== state.cursor || current.cutoff !== state.cutoff
        || current.cutoff_submillis !== state.cutoff_submillis || current.ingested) {
        throw new Error('The backfill was advanced by another process.');
      }
      for (const { id, data, updatedAt } of accepted) {
        const reason = updatedAt.valueOf() > cutoff.valueOf() ? 'changed-after-cutoff'
          : !isReadingSessionV1(data) || data.sessionId !== id ? 'invalid-session' : null;
        if (reason) {
          db.prepare('UPDATE jobs SET blocked_document = ?, blocked_reason = ? WHERE project = ? AND uid = ?')
            .run(id, reason, project, uid);
          return false;
        }
      }
      const insert = db.prepare('INSERT INTO sessions(project, uid, id, payload) VALUES (?, ?, ?, ?)');
      for (const { id, data } of accepted) insert.run(project, uid, id, JSON.stringify(toReadingSessionPayload(data)));
      db.prepare('UPDATE jobs SET cutoff = ?, cutoff_submillis = ?, cursor = ?, ingested = ? WHERE project = ? AND uid = ?')
        .run(cutoff.toMillis(), cutoff.nanoseconds % 1_000_000, documents.at(-1)?.id ?? state.cursor,
          Number(documents.length < reserved), project, uid);
      return true;
    });
    if (!staged) break;
  }

  if (job().ingested && Date.parse(job().next_week) <= through && (getBudget(startDay)?.weeks ?? 0) < dailyWeeks) {
    const sessions = db.prepare('SELECT payload FROM sessions WHERE project = ? AND uid = ? ORDER BY id COLLATE BINARY')
      .all(project, uid).map(({ payload }) => JSON.parse(payload));
    while (quotaDate.format(currentTime()) === startDay) {
      const state = job();
      const next = Date.parse(state.next_week);
      if (next > through || (getBudget(startDay)?.weeks ?? 0) >= dailyWeeks) break;
      const inputs = selectWeeklyReadingRollupInputs(sessions, state.next_week);
      const payload = JSON.stringify(computeWeeklyReadingRollup(inputs, state.next_week));
      if (Buffer.byteLength(payload) > maxDraftBytes) throw new Error('The weekly draft needs splitting before publication.');
      const staged = atomic(db, () => {
        initBudget(startDay);
        if (getBudget(startDay).weeks >= dailyWeeks) return false;
        if (job().next_week !== state.next_week) throw new Error('The backfill was advanced by another process.');
        db.prepare('INSERT INTO weeks(project, uid, week, cutoff, cutoff_submillis, payload) VALUES (?, ?, ?, ?, ?, ?)')
          .run(project, uid, state.next_week, state.cutoff, state.cutoff_submillis, payload);
        db.prepare('UPDATE jobs SET next_week = ? WHERE project = ? AND uid = ?').run(isoDate(next + weekMs), project, uid);
        db.prepare('UPDATE budgets SET weeks = weeks + 1 WHERE project = ? AND day = ?').run(project, startDay);
        return true;
      });
      if (!staged) break;
      stagedWeeks += 1;
    }
  }

  const state = job();
  const budget = getBudget(startDay);
  return {
    status: state.blocked_reason ? 'blocked' : Date.parse(state.next_week) > through ? 'complete' : state.ingested ? 'staging' : 'reading',
    ...(state.blocked_reason ? { blocked: { documentId: state.blocked_document, reason: state.blocked_reason } } : {}),
    nextWeek: state.next_week,
    stagedWeeks,
    reservedReadsToday: budget?.reads ?? 0,
    stagedWeeksToday: budget?.weeks ?? 0,
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    project: { type: 'string' }, uid: { type: 'string' },
    'first-week': { type: 'string' }, 'through-week': { type: 'string' },
    'confirm-live-read': { type: 'boolean', default: false },
    state: { type: 'string', default: join(homedir(), '.local', 'state', 'web-reader', 'statistics-backfill.sqlite') },
    'daily-reads': { type: 'string', default: '1000' },
    'daily-weeks': { type: 'string', default: '5' },
  } });
  const { project, uid } = values;
  const firstWeek = values['first-week'];
  const throughWeek = values['through-week'];
  const dailyReads = Number(values['daily-reads']);
  const dailyWeeks = Number(values['daily-weeks']);
  if (!project || !/^[a-z0-9-]+$/.test(project) || !uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)
    || !firstWeek || !throughWeek || !Number.isInteger(dailyReads) || dailyReads < 1 || dailyReads > 5000
    || !Number.isInteger(dailyWeeks) || dailyWeeks < 1 || dailyWeeks > 9) {
    throw new Error('Provide --project, --uid, --first-week and --through-week. Daily limits: 1–5000 reads and 1–9 weeks.');
  }
  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulator && (!values['confirm-live-read'] || project.startsWith('demo-'))) {
    throw new Error('Set FIRESTORE_EMULATOR_HOST or explicitly confirm reads with --confirm-live-read.');
  }
  process.umask(0o077);
  mkdirSync(dirname(resolve(values.state)), { recursive: true, mode: 0o700 });
  const state = openBackfillState(values.state);
  const app = initializeApp({ projectId: project });
  try {
    const source = getFirestore(app).collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
    const result = await stageReadingStatisticsBackfill(state, {
      project: emulator ? `emulator:${emulator}:${project}` : project,
      uid, firstWeek, throughWeek, dailyReads, dailyWeeks,
      async readPage(cursor, limit) {
        const ordered = source.orderBy(FieldPath.documentId());
        const page = await (cursor ? ordered.startAfter(cursor) : ordered).limit(limit).get();
        return {
          readTime: page.readTime,
          documents: page.docs.map((document) => ({
            id: document.id,
            createdAt: document.createTime,
            updatedAt: document.updateTime,
            data: document.data(),
          })),
        };
      },
    });
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 1;
  } finally {
    state.close();
    await deleteApp(app);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
