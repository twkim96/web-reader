import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { APP_ID } from '../../lib/appIdentity';
import { buildReadingStatistics, getReadingSessionLocalDate, isReadingSessionV1, type ReadingSessionV1 } from '../../lib/readingStatistics';
import { resolveSocialWork } from './catalog';

type Work = { fileIds: Set<string>; progress: number };
type Summary = {
  works: Map<string, Work>;
  totals: Map<string, number>;
  hasUnidentifiedFiles: boolean;
  conflictedWorks: Set<string>;
  marker: string | null;
  builtAt: number;
};
const caches = new WeakMap<Firestore, Map<string, { expires: number; promise: Promise<Summary> }>>();

const PAGE_SIZE = 300;
const RECHECK_MS = 30_000;
const FULL_REFRESH_MS = 5 * 60_000;

// After a short reuse window, check the latest upload before rescanning history.
async function summary(db: Firestore, uid: string): Promise<Summary> {
  if (!uid || uid.includes('/')) throw new Error('Invalid account');
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const found = cache.get(uid);
  if (found && found.expires > Date.now()) return found.promise;
  const promise = buildSummary(db, uid, found?.promise);
  cache.delete(uid);
  cache.set(uid, { expires: Date.now() + RECHECK_MS, promise });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
  promise.catch(() => { if (cache?.get(uid)?.promise === promise) cache.delete(uid); });
  return promise;
}

async function buildSummary(db: Firestore, uid: string, previous?: Promise<Summary>): Promise<Summary> {
  const collection = db.collection(`artifacts/${APP_ID}/users/${uid}/libraries/local/readingStatsV1`);
  const latest = (await collection.orderBy('uploadedAtServer', 'desc').limit(1).get()).docs[0];
  const stamp = latest?.get('uploadedAtServer');
  const marker = stamp ? JSON.stringify([stamp.seconds, stamp.nanoseconds, latest.id]) : null;
  const retained = await previous?.catch(() => null);
  if (marker && retained?.marker === marker && Date.now() - retained.builtAt < FULL_REFRESH_MS) return retained;

  const ordered = collection.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
  const sessions: ReadingSessionV1[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const snapshot = await (cursor ? ordered.startAfter(cursor) : ordered).get();
    for (const doc of snapshot.docs) {
      const value = doc.data();
      if (typeof value.startedAtClient !== 'number' || typeof value.timezoneOffsetMinutes !== 'number') continue;
      let localDate: string;
      try { localDate = getReadingSessionLocalDate(value.startedAtClient, value.timezoneOffsetMinutes); } catch { continue; }
      const session = { ...value, localDate };
      if (isReadingSessionV1(session) && session.sessionId === doc.id) sessions.push(session);
    }
    if (snapshot.docs.length < PAGE_SIZE) break;
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  const titles = [...new Set(sessions.map((s) => s.bookTitle))];
  const resolved = new Map<string, Awaited<ReturnType<typeof resolveSocialWork>>>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, titles.length) }, async () => {
    while (next < titles.length) { const title = titles[next++]; resolved.set(title, await resolveSocialWork(db, title)); }
  }));
  const works = new Map<string, Work>();
  const fileWorks = new Map<string, Set<string>>();
  for (const session of sessions) {
    const result = resolved.get(session.bookTitle);
    if (!result) continue;
    const ids = fileWorks.get(session.bookId) ?? new Set<string>();
    ids.add(result.book.id); fileWorks.set(session.bookId, ids);
  }
  const conflictedWorks = new Set<string>();
  for (const ids of fileWorks.values()) {
    if (ids.size > 1) for (const id of ids) conflictedWorks.add(id);
  }
  const totals = new Map<string, number>();
  const sessionWork = new Map<string, string>();
  let hasUnidentifiedFiles = false;
  for (const session of sessions) {
    const result = resolved.get(session.bookTitle);
    const ids = fileWorks.get(session.bookId);
    const id = result?.book.id ?? (ids?.size === 1 ? [...ids][0] : undefined);
    // A title can miss even though another record identifies the same file.
    if (!ids && session.completionRoundNumber === undefined) hasUnidentifiedFiles = true;
    if (!id || (ids && (ids.size !== 1 || !ids.has(id)))) continue;
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
  return { works, totals, hasUnidentifiedFiles, conflictedWorks, marker, builtAt: Date.now() };
}

export async function getSocialReadingEvidence(db: Firestore, uid: string, canonicalWorkId: string, fileIds: readonly string[]): Promise<{ totalMs: number | null; progressPercent: number | null }> {
  const resolved = await resolveSocialWork(db, canonicalWorkId);
  if (!resolved || resolved.book.id !== canonicalWorkId) return { totalMs: null, progressPercent: null };
  const data = await summary(db, uid);
  if (data.hasUnidentifiedFiles || data.conflictedWorks.has(canonicalWorkId)) return { totalMs: null, progressPercent: null };
  const work = data.works.get(canonicalWorkId);
  // File ids are hints only; a supplied id must actually belong to this work.
  if (!work || !work.fileIds.size || (fileIds.length > 0 && !fileIds.some((id) => work.fileIds.has(id)))) return { totalMs: null, progressPercent: null };
  return { totalMs: data.totals.get(canonicalWorkId) ?? 0, progressPercent: work.progress };
}
