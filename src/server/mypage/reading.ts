import {
  FieldPath, Timestamp, type CollectionReference, type Firestore, type Query, type QueryDocumentSnapshot, type Transaction,
} from 'firebase-admin/firestore';
import { APP_ID } from '../../lib/appIdentity';
import { buildReadingStatistics, getReadingSessionLocalDate, isReadingSessionV1, toReadingSessionPayload, type ReadingSessionV1 } from '../../lib/readingStatistics';
import { resolveSocialReadingTitle, resolveSocialWork } from './catalog';
import { reportMyPageApiTiming, type ReadingEvidenceRoute } from './performance';

type Work = { fileIds: Set<string>; progress: number };
type Cursor = { stamp: Timestamp; id: string };
type History = { sessions: ReadingSessionV1[]; documentCount: number; bytes: number; fullScanAt: number };
type Summary = {
  works: Map<string, Work>;
  totals: Map<string, number>;
  conflictedWorks: Set<string>;
  cursor: Cursor | null;
  empty: boolean;
  history: History | null;
  builtAt: number;
};
type ReadCounts = { markerDocuments: number; countQueries: number; scanQueries: number; scanDocuments: number; emptyScanQueries: number };
const caches = new WeakMap<Firestore, Map<string, { expires: number; promise: Promise<Summary> }>>();

const PAGE_SIZE = 300;
const RECHECK_MS = 30_000;
const REBUILD_SUMMARY_MS = 5 * 60_000;
const FULL_SCAN_MS = 30 * 60_000;
const MAX_CACHED_ACCOUNTS = 8;
const MAX_HISTORY_DOCUMENTS = 12_000;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

const compareIds = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const compareCursors = (left: Cursor, right: Cursor) => left.stamp.seconds - right.stamp.seconds
  || left.stamp.nanoseconds - right.stamp.nanoseconds || compareIds(left.id, right.id);

async function summary(db: Firestore, uid: string, route?: ReadingEvidenceRoute): Promise<Summary> {
  if (!uid || uid.includes('/')) throw new Error('Invalid account');
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const found = cache.get(uid);
  if (found && found.expires > Date.now()) {
    cache.delete(uid);
    cache.set(uid, found);
    return found.promise;
  }
  const start = performance.now();
  const counts: ReadCounts = { markerDocuments: 0, countQueries: 0, scanQueries: 0, scanDocuments: 0, emptyScanQueries: 0 };
  const promise = buildSummary(db, uid, counts, found?.promise).finally(() => {
    if (route) reportMyPageApiTiming(route, start, counts);
  });
  const entry = { expires: Infinity, promise };
  cache.delete(uid);
  cache.set(uid, entry);
  while (cache.size > MAX_CACHED_ACCOUNTS) cache.delete(cache.keys().next().value!);
  void entry.promise.then(() => {
    entry.expires = Date.now() + RECHECK_MS;
  }, () => {
    if (cache.get(uid) === entry) cache.delete(uid);
  });
  return entry.promise;
}

function parseSession(document: QueryDocumentSnapshot) {
  const value = document.data();
  if (typeof value.startedAtClient !== 'number' || typeof value.timezoneOffsetMinutes !== 'number') return null;
  let localDate: string;
  try { localDate = getReadingSessionLocalDate(value.startedAtClient, value.timezoneOffsetMinutes); } catch { return null; }
  const session = { ...value, localDate };
  if (!isReadingSessionV1(session) || session.sessionId !== document.id) return null;
  return toReadingSessionPayload(session);
}

async function scanSessions(transaction: Transaction, source: Query, counts: ReadCounts) {
  const ordered = source.limit(PAGE_SIZE);
  const sessions: ReadingSessionV1[] = [];
  let documentCount = 0;
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    counts.scanQueries++;
    const snapshot = await transaction.get(cursor ? ordered.startAfter(cursor) : ordered);
    documentCount += snapshot.docs.length;
    counts.scanDocuments += snapshot.docs.length;
    counts.emptyScanQueries += Number(snapshot.docs.length === 0);
    for (const document of snapshot.docs) {
      const session = parseSession(document);
      if (session) sessions.push(session);
    }
    if (snapshot.docs.length < PAGE_SIZE) return { sessions, documentCount };
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
}

function historyBytes(sessions: ReadingSessionV1[]) {
  let bytes = 0;
  for (const session of sessions) {
    bytes += Buffer.byteLength(JSON.stringify(session));
    if (bytes > MAX_HISTORY_BYTES) break;
  }
  return bytes;
}

async function readHistory(
  transaction: Transaction,
  collection: CollectionReference,
  cursor: Cursor | null,
  retained: Summary | null,
  now: number,
  counts: ReadCounts,
): Promise<History> {
  const cached = retained?.history;
  const previous = retained?.cursor;
  if (cached && previous && cursor && now - cached.fullScanAt < FULL_SCAN_MS) {
    const order = compareCursors(cursor, previous);
    if (order >= 0) {
      counts.countQueries++;
      const { count } = (await transaction.get(collection.count())).data();
      if (order === 0 && count === cached.documentCount) return cached;
      if (order > 0 && count > cached.documentCount && count <= MAX_HISTORY_DOCUMENTS) {
        const newer = await scanSessions(transaction, collection.orderBy('uploadedAtServer')
          .orderBy(FieldPath.documentId()).startAfter(previous.stamp, previous.id), counts);
        if (count === cached.documentCount + newer.documentCount) {
          // Keep the original document-ID order, including tie-breaking in
          // the clock-sample and completed-round calculations.
          const sessions = [...cached.sessions, ...newer.sessions].sort((a, b) => compareIds(a.sessionId, b.sessionId));
          return { sessions, documentCount: count, bytes: cached.bytes + historyBytes(newer.sessions), fullScanAt: cached.fullScanAt };
        }
      }
    }
  }

  // A full scan includes legacy records without an upload timestamp.
  const full = await scanSessions(transaction, collection.orderBy(FieldPath.documentId()), counts);
  return { ...full, bytes: historyBytes(full.sessions), fullScanAt: now };
}

async function buildSummary(
  db: Firestore,
  uid: string,
  counts: ReadCounts,
  previous?: Promise<Summary>,
): Promise<Summary> {
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
  const latest = await collection.orderBy('uploadedAtServer', 'desc').orderBy(FieldPath.documentId(), 'desc').limit(1).get();
  const last = latest.docs[0];
  counts.markerDocuments = Number(Boolean(last));
  const stamp = last?.get('uploadedAtServer');
  const cursor = stamp instanceof Timestamp ? { stamp, id: last.id } : null;
  const retained = await previous?.catch(() => null) ?? null;
  const now = Date.now();
  const unchanged = cursor && retained?.cursor ? compareCursors(cursor, retained.cursor) === 0 : !last && retained?.empty;
  if (retained && unchanged && now - retained.builtAt < REBUILD_SUMMARY_MS
    && (!retained.history || now - retained.history.fullScanAt < FULL_SCAN_MS)) return retained;

  // Check counts and pages against the same snapshot as the latest cursor.
  // Resolving titles happens after the transaction and can use the catalog cache.
  const history = await db.runTransaction(
    (transaction) => readHistory(transaction, collection, cursor, retained, now, counts),
    { readOnly: true, readTime: latest.readTime },
  );
  const sessions = history.sessions;
  const titles = [...new Set(sessions.map((s) => s.bookTitle))];
  const resolved = new Map<string, Awaited<ReturnType<typeof resolveSocialReadingTitle>>>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, titles.length) }, async () => {
    while (next < titles.length) {
      const title = titles[next++];
      resolved.set(title, await resolveSocialReadingTitle(db, title));
    }
  }));
  const works = new Map<string, Work>();
  const fileWorks = new Map<string, Set<string>>();
  const uncertainFiles = new Set<string>();
  for (const session of sessions) {
    const result = resolved.get(session.bookTitle);
    if (!result) continue;
    if (result.uncertain) uncertainFiles.add(session.bookId);
    if (result.roots.size === 0) continue;
    const ids = fileWorks.get(session.bookId) ?? new Set<string>();
    for (const id of result.roots) ids.add(id);
    fileWorks.set(session.bookId, ids);
  }
  const conflictedWorks = new Set<string>();
  for (const [file, ids] of fileWorks) {
    if (ids.size > 1 || uncertainFiles.has(file)) for (const id of ids) conflictedWorks.add(id);
  }
  const totals = new Map<string, number>();
  const sessionWork = new Map<string, string>();
  for (const session of sessions) {
    const ids = fileWorks.get(session.bookId);
    if (ids?.size !== 1 || uncertainFiles.has(session.bookId)) continue;
    // An old name can miss while another session still identifies the file.
    const [id] = ids;
    sessionWork.set(session.sessionId, id);
    const work = works.get(id) ?? { fileIds: new Set<string>(), progress: 0 };
    if (session.completionRoundNumber === undefined) {
      work.fileIds.add(session.bookId);
      work.progress = Math.max(work.progress, session.startProgressPercent, session.endProgressPercent);
    }
    works.set(id, work);
  }
  buildReadingStatistics(sessions, {}, ({ session, durationMs }) => {
    const id = sessionWork.get(session.sessionId);
    if (id) totals.set(id, (totals.get(id) ?? 0) + durationMs);
  });
  return {
    works, totals, conflictedWorks, cursor, empty: history.documentCount === 0, builtAt: now,
    history: history.documentCount <= MAX_HISTORY_DOCUMENTS && history.bytes <= MAX_HISTORY_BYTES ? history : null,
  };
}

export async function getSocialReadingEvidence(
  db: Firestore, uid: string, canonicalWorkId: string, fileIds: readonly string[], route?: ReadingEvidenceRoute,
): Promise<{ totalMs: number | null; progressPercent: number | null }> {
  const resolved = await resolveSocialWork(db, canonicalWorkId);
  if (!resolved || resolved.book.id !== canonicalWorkId) return { totalMs: null, progressPercent: null };
  const data = await summary(db, uid, route);
  if (data.conflictedWorks.has(canonicalWorkId)) return { totalMs: null, progressPercent: null };
  const work = data.works.get(canonicalWorkId);
  // File ids are hints only; a supplied id must actually belong to this work.
  if (!work || !work.fileIds.size || (fileIds.length > 0 && !fileIds.some((id) => work.fileIds.has(id)))) return { totalMs: null, progressPercent: null };
  return { totalMs: data.totals.get(canonicalWorkId) ?? 0, progressPercent: work.progress };
}
