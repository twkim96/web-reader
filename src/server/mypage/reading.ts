import {
  FieldPath, Timestamp, type CollectionReference, type Firestore, type Query, type QueryDocumentSnapshot, type Transaction,
} from 'firebase-admin/firestore';
import { APP_ID } from '../../lib/appIdentity';
import { getPublicBookMetadataAliasCandidates } from '../../lib/publicBookMetadataSchema';
import { buildReadingStatistics, getReadingSessionLocalDate, isReadingSessionV1, sameReadingSessionPayload, toReadingSessionPayload, type ReadingSessionV1 } from '../../lib/readingStatistics';
import { computeReadingFileRollups, mergeReadingFileRollups } from '../../lib/readingStatisticsRollup';
import { compareReadingUploadTimes, selectReadingRollupTail, type ReadingUploadTime } from '../../lib/readingRollupBootstrap';
import { addReadingRollupPage, sortReadingRollupCarry } from '../readingRollupInputs';
import { readPublishedReadingEvidenceInputs } from '../readingRollupRead';
import { readingDaySource, readingDayWindowQuery, readReadingDayWindowMemberRows } from '../readingStatisticsDayStore';
import { loadSocialCatalog, resolveSocialReadingTitle, resolveSocialWork } from './catalog';
import { reportMyPageApiTiming, type ReadingEvidenceRoute } from './performance';

type Work = { fileIds: Set<string>; progress: number };
type Cursor = { stamp: Timestamp; id: string };
type RawHistory = { sessions: ReadingSessionV1[]; bytes: number };
type History = RawHistory & { documentCount: number; fullScanAt: number };
type FileEvidence = { titles: Set<string>; progress?: number; durationMs: number };
type TitleMatch = Awaited<ReturnType<typeof resolveSocialReadingTitle>>;
type HistoryEvidence = {
  documentCount: number;
  fullScanAt: number;
  fileEvidence: { files: Map<string, FileEvidence>; bytes: number } | null;
  rawHistory: RawHistory | null;
};
type RetainedHistoryEvidence = HistoryEvidence & { fileEvidence: NonNullable<HistoryEvidence['fileEvidence']> };
type Summary = HistoryEvidence & {
  works: Map<string, Work>;
  totals: Map<string, number>;
  conflictedWorks: Set<string>;
  cursor: Cursor | null;
  builtAt: number;
  legacyOnly?: true;
};
type FullScanReason =
  | 'fullScanCold'
  | 'fullScanAudit'
  | 'fullScanMissingCursor'
  | 'fullScanRegressedCursor'
  | 'fullScanCountMismatch'
  | 'fullScanRawUnavailable'
  | 'fullScanEvidenceLimit'
  | 'fullScanAppendLimit';
type ReadCounts = {
  markerDocuments: number; countQueries: number; scanQueries: number; scanDocuments: number; emptyScanQueries: number;
  timelineBuilds: number; aliasResolutions: number;
  markerOnly?: number; evidenceReused?: number; retainedEvidenceBytes?: number; retainedRawBytes?: number;
  publishedFiles?: number;
} & Partial<Record<FullScanReason, number>>;
const caches = new WeakMap<Firestore, Map<string, { expires: number; promise: Promise<Summary> }>>();
let publishedCatalog: ReturnType<typeof loadSocialCatalog> | undefined;

const PAGE_SIZE = 300;
const RECHECK_MS = 30_000;
const REBUILD_SUMMARY_MS = 5 * 60_000;
const FULL_SCAN_MS = 30 * 60_000;
const MAX_CACHED_ACCOUNTS = 8;
const MAX_HISTORY_DOCUMENTS = 12_000;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_FILE_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_PUBLISHED_DELTA_ROWS = 1_200;
const BOUNDED_PAGE_SIZE = 32;
type EvidenceRow = { session: ReadingSessionV1; firstReceivedAt: ReadingUploadTime };
type EvidenceSource = {
  query: Query;
  read: (doc: QueryDocumentSnapshot, data: Record<string, unknown>) => EvidenceRow[];
};

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
    if (route) reportMyPageApiTiming(route, performance.now(), { inMemoryHit: 1 });
    return found.promise;
  }
  const start = performance.now();
  const counts: ReadCounts = {
    markerDocuments: 0, countQueries: 0, scanQueries: 0, scanDocuments: 0, emptyScanQueries: 0,
    timelineBuilds: 0, aliasResolutions: 0,
  };
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

function parseSession(document: QueryDocumentSnapshot, value = document.data()) {
  if (typeof value.startedAtClient !== 'number' || typeof value.timezoneOffsetMinutes !== 'number') return null;
  let localDate: string;
  try { localDate = getReadingSessionLocalDate(value.startedAtClient, value.timezoneOffsetMinutes); } catch { return null; }
  const session = { ...value, localDate };
  if (!isReadingSessionV1(session) || session.sessionId !== document.id) return null;
  return toReadingSessionPayload(session);
}

async function readBoundedEvidenceRows(
  transaction: Transaction, sources: EvidenceSource[], maxRows: number, counts: ReadCounts,
  carry: readonly ReadingSessionV1[] = [],
) {
  const seen = new Map(carry.map((session) => [session.sessionId, session]));
  const rows: EvidenceRow[] = [];
  let documents = 0;
  let entries = 0;
  let bytes = 0;
  for (const { query, read } of sources) {
    let cursor: QueryDocumentSnapshot | undefined;
    for (;;) {
      const limit = Math.min(BOUNDED_PAGE_SIZE, maxRows - documents + 1);
      const page = await transaction.get((cursor ? query.startAfter(cursor) : query).limit(limit));
      counts.scanQueries++;
      counts.scanDocuments += page.size;
      counts.emptyScanQueries += Number(page.empty);
      documents += page.size;
      if (documents > maxRows) throw new RangeError('Reading evidence document limit');
      for (const doc of page.docs) {
        const data = doc.data();
        bytes += Buffer.byteLength(JSON.stringify(data));
        if (bytes > MAX_HISTORY_BYTES) throw new RangeError('Reading evidence byte limit');
        const incoming = read(doc, data);
        entries += incoming.length;
        if (entries > maxRows) throw new RangeError('Reading evidence entry limit');
        for (const row of incoming) {
          const { session } = row;
          const previous = seen.get(session.sessionId);
          if (previous) {
            if (!sameReadingSessionPayload(previous, session)) throw new Error('Conflicting reading evidence');
            continue;
          }
          seen.set(session.sessionId, session);
          rows.push(row);
        }
      }
      if (page.size < limit) break;
      cursor = page.docs[page.size - 1];
    }
  }
  return rows;
}

function legacyEvidenceRows(doc: QueryDocumentSnapshot, data: Record<string, unknown>): EvidenceRow[] {
  const session = parseSession(doc, data);
  // The full history also includes legacy sessions without a receipt timestamp.
  const firstReceivedAt = data.uploadedAtServer instanceof Timestamp ? data.uploadedAtServer : new Timestamp(0, 0);
  return session ? [{ session, firstReceivedAt }] : [];
}

const legacySource = (db: Firestore, uid: string) =>
  db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);

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
): Promise<History | RetainedHistoryEvidence> {
  const fullScan = async (reason: FullScanReason) => {
    counts[reason] = 1;
    // A full scan includes legacy records without an upload timestamp.
    const full = await scanSessions(transaction, collection.orderBy(FieldPath.documentId()), counts);
    return { ...full, bytes: historyBytes(full.sessions), fullScanAt: now };
  };

  if (!retained) return fullScan('fullScanCold');
  if (now - retained.fullScanAt >= FULL_SCAN_MS) return fullScan('fullScanAudit');
  if (!retained.cursor || !cursor) return fullScan('fullScanMissingCursor');
  const order = compareCursors(cursor, retained.cursor);
  if (order < 0) return fullScan('fullScanRegressedCursor');

  counts.countQueries++;
  const { count } = (await transaction.get(collection.count())).data();
  if (order === 0 && count === retained.documentCount) {
    if (retained.fileEvidence) return { ...retained, fileEvidence: retained.fileEvidence };
    if (retained.rawHistory) return { ...retained.rawHistory, documentCount: count, fullScanAt: retained.fullScanAt };
    return fullScan('fullScanEvidenceLimit');
  }
  if (order === 0 || count <= retained.documentCount) return fullScan('fullScanCountMismatch');

  const raw = retained.rawHistory;
  if (!raw) return fullScan('fullScanRawUnavailable');
  if (count > MAX_HISTORY_DOCUMENTS) return fullScan('fullScanAppendLimit');
  const newer = await scanSessions(transaction, collection.orderBy('uploadedAtServer')
    .orderBy(FieldPath.documentId()).startAfter(retained.cursor.stamp, retained.cursor.id), counts);
  if (count !== retained.documentCount + newer.documentCount) return fullScan('fullScanCountMismatch');

  // Keep the original document-ID order, including tie-breaking in
  // the clock-sample and completed-round calculations.
  const sessions = newer.sessions.length
    ? [...raw.sessions, ...newer.sessions].sort((a, b) => compareIds(a.sessionId, b.sessionId))
    : raw.sessions;
  return { sessions, documentCount: count, bytes: raw.bytes + historyBytes(newer.sessions), fullScanAt: retained.fullScanAt };
}

function buildFileEvidence(sessions: ReadingSessionV1[], counts: ReadCounts) {
  const files = new Map<string, FileEvidence>();
  for (const session of sessions) {
    const file = files.get(session.bookId) ?? { titles: new Set<string>(), durationMs: 0 };
    file.titles.add(session.bookTitle);
    if (session.completionRoundNumber === undefined) {
      file.progress = Math.max(file.progress ?? 0, session.startProgressPercent, session.endProgressPercent);
    }
    files.set(session.bookId, file);
  }
  // Count across every file before assigning titles. Overlap or a clock sample
  // from another book can change a file's time even when its own sessions match.
  counts.timelineBuilds++;
  buildReadingStatistics(sessions, {}, ({ session, durationMs }) => {
    files.get(session.bookId)!.durationMs += durationMs;
  });
  return files;
}

function estimateFileEvidenceBytes(files: Map<string, FileEvidence>) {
  let bytes = 0;
  for (const [id, file] of files) {
    bytes += 128 + id.length * 2;
    for (const title of file.titles) bytes += 48 + title.length * 2;
    if (bytes > MAX_FILE_EVIDENCE_BYTES) break;
  }
  return bytes;
}

async function resolveReadingTitles(db: Firestore, files: Map<string, FileEvidence>, counts: ReadCounts) {
  const titles = new Set<string>();
  for (const file of files.values()) for (const title of file.titles) titles.add(title);
  const resolved = new Map<string, TitleMatch>();
  if (!titles.size) return resolved;

  publishedCatalog ??= loadSocialCatalog().catch((error) => { publishedCatalog = undefined; throw error; });
  const catalog = await publishedCatalog;
  const aliasGroups = new Map<string, string[]>();
  for (const title of titles) {
    const published = catalog.get(title);
    if (published) {
      resolved.set(title, { roots: new Set([published.id]), uncertain: false });
      continue;
    }
    // The resolver tries the same ordered candidates for filename variants.
    // Only share within this build so remaps keep the catalog's own freshness.
    const key = JSON.stringify(getPublicBookMetadataAliasCandidates(title));
    const group = aliasGroups.get(key) ?? [];
    group.push(title);
    aliasGroups.set(key, group);
  }

  const groups = aliasGroups.values();
  await Promise.all(Array.from({ length: Math.min(8, aliasGroups.size) }, async () => {
    for (const group of groups) {
      counts.aliasResolutions++;
      const match = await resolveSocialReadingTitle(db, group[0]);
      for (const title of group) resolved.set(title, match);
    }
  }));
  return resolved;
}

async function publishedFileEvidence(db: Firestore, uid: string, counts: ReadCounts): Promise<Map<string, FileEvidence> | null> {
  const rollup = await readPublishedReadingEvidenceInputs(db, uid);
  if (!rollup) return null;
  const collection = legacySource(db, uid);
  const through = rollup.readTime;
  if (compareReadingUploadTimes(rollup.sourceThrough, through) > 0) return null;
  // Freeze both sources and all pages so a container append cannot move an
  // unread part past one page's cursor while another page is being read.
  const rows = await db.runTransaction((transaction) => readBoundedEvidenceRows(transaction, [
    {
      query: collection.orderBy('uploadedAtServer').orderBy(FieldPath.documentId())
        .startAfter(rollup.sourceThrough).endAt(through),
      read: legacyEvidenceRows,
    },
    {
      query: readingDayWindowQuery(db, uid, rollup.sourceThrough, through),
      read: (doc, data) => readReadingDayWindowMemberRows({ id: doc.id, data: () => data }, rollup.sourceThrough, through),
    },
  ], MAX_PUBLISHED_DELTA_ROWS, counts, rollup.carry.sessions), { readOnly: true, readTime: through });
  const sessions = rows.sort((a, b) => compareReadingUploadTimes(a.firstReceivedAt, b.firstReceivedAt)
    || compareIds(a.session.sessionId, b.session.sessionId)).map(({ session }) => session);
  const closedDay = new Date(Date.parse(rollup.nextWeek) - 86_400_000).toISOString().slice(0, 10);
  const accepted = selectReadingRollupTail({ lastDay: closedDay, sampleFloor: rollup.carry.sampleFloor }, rollup.carry.sessions, sessions);
  const combined = sortReadingRollupCarry(addReadingRollupPage(rollup.carry, accepted, rollup.nextWeek));
  counts.timelineBuilds++;
  const open = computeReadingFileRollups(combined.sessions, { bounds: { startLocalDate: rollup.nextWeek } });
  const files = mergeReadingFileRollups(rollup.files, open);
  counts.publishedFiles = files.length;
  return new Map(files.map((file) => [file.fileId, {
    titles: new Set(file.titles), durationMs: file.unfilteredMs, progress: file.absoluteMaxProgressPercent,
  }]));
}

async function resolveUnretainedSummary(db: Firestore, files: Map<string, FileEvidence> | null, counts: ReadCounts): Promise<Summary> {
  const resolved = files ? await resolveFileEvidence(db, files, counts)
    : { works: new Map(), totals: new Map(), conflictedWorks: new Set<string>() };
  return { ...resolved, cursor: null, fileEvidence: null, documentCount: 0, fullScanAt: 0,
    rawHistory: null, builtAt: Date.now() };
}

async function buildSummary(
  db: Firestore,
  uid: string,
  counts: ReadCounts,
  previous?: Promise<Summary>,
): Promise<Summary> {
  if (process.env.NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS === '1') {
    const rolled = await publishedFileEvidence(db, uid, counts).catch(() => null);
    return resolveUnretainedSummary(db, rolled, counts);
  }
  const collection = legacySource(db, uid);
  const latest = await collection.orderBy('uploadedAtServer', 'desc').orderBy(FieldPath.documentId(), 'desc')
    .select('uploadedAtServer').limit(1).get();
  const last = latest.docs[0];
  counts.markerDocuments = Number(Boolean(last));
  const stamp = last?.get('uploadedAtServer');
  const cursor = stamp instanceof Timestamp ? { stamp, id: last.id } : null;
  const cached = await previous?.catch(() => null) ?? null;
  const retained = cached?.legacyOnly ? cached : null;
  const now = Date.now();
  const unchanged = cursor && retained?.cursor
    ? compareCursors(cursor, retained.cursor) === 0
    : !last && retained?.documentCount === 0;
  // Check for V2 at the same snapshot as the legacy cursor, even on a cache
  // recheck. Appending to a day part never advances the legacy marker.
  // Resolving titles happens after the transaction and can use the catalog cache.
  const through = latest.readTime;
  const daySource = readingDaySource(db, uid);
  const result = await db.runTransaction(async (transaction) => {
    const dayMarker = await transaction.get(daySource.select().limit(1));
    counts.markerDocuments += dayMarker.size;
    if (!dayMarker.empty) {
      const rows = await readBoundedEvidenceRows(transaction, [
        { query: collection.orderBy(FieldPath.documentId()), read: legacyEvidenceRows },
        {
          query: daySource.orderBy(FieldPath.documentId()),
          read: (doc, data) => readReadingDayWindowMemberRows({ id: doc.id, data: () => data }, undefined, through),
        },
      ], MAX_HISTORY_DOCUMENTS, counts).catch(() => null);
      return { mixed: rows };
    }
    if (retained && unchanged && now - retained.builtAt < REBUILD_SUMMARY_MS
      && now - retained.fullScanAt < FULL_SCAN_MS) {
      counts.markerOnly = 1;
      return { cached: retained };
    }
    return { history: await readHistory(transaction, collection, cursor, retained, now, counts) };
  }, { readOnly: true, readTime: through });
  if (result.cached) return result.cached;
  if (!result.history) {
    const files = result.mixed ? buildFileEvidence(result.mixed.map(({ session }) => session)
      .sort((a, b) => compareIds(a.sessionId, b.sessionId)), counts) : null;
    return resolveUnretainedSummary(db, files, counts);
  }
  const { history } = result;
  const { documentCount, fullScanAt } = history;
  const previousEvidence = 'fileEvidence' in history ? history.fileEvidence
    : history.sessions === retained?.rawHistory?.sessions ? retained?.fileEvidence : null;
  const files = 'fileEvidence' in history ? history.fileEvidence.files
    : previousEvidence?.files ?? buildFileEvidence(history.sessions, counts);
  const bytes = previousEvidence?.bytes ?? estimateFileEvidenceBytes(files);
  const fileEvidence = bytes <= MAX_FILE_EVIDENCE_BYTES ? { files, bytes } : null;
  counts.evidenceReused = Number(Boolean(previousEvidence));
  counts.retainedEvidenceBytes = fileEvidence?.bytes ?? 0;
  const rawHistory = 'rawHistory' in history ? history.rawHistory
    : documentCount <= MAX_HISTORY_DOCUMENTS && history.bytes <= MAX_HISTORY_BYTES
      ? { sessions: history.sessions, bytes: history.bytes } : null;
  counts.retainedRawBytes = rawHistory?.bytes ?? 0;
  return { ...await resolveFileEvidence(db, files, counts), cursor, fileEvidence, documentCount, fullScanAt, rawHistory, builtAt: now,
    legacyOnly: true };
}

async function resolveFileEvidence(db: Firestore, files: Map<string, FileEvidence>, counts: ReadCounts) {
  const resolved = await resolveReadingTitles(db, files, counts);
  const works = new Map<string, Work>();
  const conflictedWorks = new Set<string>();
  const totals = new Map<string, number>();
  for (const [fileId, file] of files) {
    const ids = new Set<string>();
    let uncertain = false;
    for (const title of file.titles) {
      const result = resolved.get(title)!;
      uncertain ||= result.uncertain;
      for (const id of result.roots) ids.add(id);
    }
    if (ids.size > 1 || uncertain) {
      for (const id of ids) conflictedWorks.add(id);
      continue;
    }
    if (!ids.size) continue;
    // An old name can miss while another session still identifies the file.
    const [id] = ids;
    const work = works.get(id) ?? { fileIds: new Set<string>(), progress: 0 };
    if (file.progress !== undefined) {
      work.fileIds.add(fileId);
      work.progress = Math.max(work.progress, file.progress);
    }
    works.set(id, work);
    totals.set(id, (totals.get(id) ?? 0) + file.durationMs);
  }
  return { works, totals, conflictedWorks };
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
