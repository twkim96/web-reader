import type { Book, Bookmark, UserProgress } from '../types';
import type { OwnerKey } from './ownerIdentity';
import { getPublicBookMetadataAliasCandidates, type PublicBookMetadata } from './publicBookMetadataSchema';
import { getPlatformWorkKeys, groupPublicBookWorks, selectSyncedReadingSessions } from './readBooks';
import { buildReadingStatistics, type StoredReadingSessionV11 } from './readingStatistics';
import { extendPublishedReadingFiles, type PublishedReadingFiles } from './readingStatisticsRollup';

const reviewSuffix = '/review';
export const bookDetailHref = (bookId: string, focusReview = false) =>
  `#mypage/book/${encodeURIComponent(bookId)}${focusReview ? reviewSuffix : ''}`;

export const hasBookReviewTarget = (hash: string) => hash.endsWith(reviewSuffix) && readBookDetailId(hash) !== null;

export function readBookDetailId(hash: string) {
  const prefix = '#mypage/book/';
  if (!hash.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(hash.slice(prefix.length, hash.endsWith(reviewSuffix) ? -reviewSuffix.length : undefined));
    return isBookDetailId(id) ? id : null;
  } catch {
    return null;
  }
}

export const isBookDetailId = (id: unknown): id is string =>
  typeof id === 'string' && id.length <= 500 && id.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(id);

type Range = [number, number];
export type PersonalBookReading = {
  bookmarks: Bookmark[];
  totalMs: number;
  progressPercent: number;
  fileIds: string[];
  reviewFileIds: string[] | null;
  reviewHistoryPartial: boolean;
  hasRead: boolean;
};

const visibleReadingSessions = (sessions: readonly StoredReadingSessionV11[], ownerKey: OwnerKey) => (
  sessions.filter((session) => session.ownerKey === ownerKey
    && session.completionRoundNumber === undefined)
);

export function buildLocalReviewReading(
  sessions: readonly StoredReadingSessionV11[], ownerKey: OwnerKey, fileIds: readonly string[],
) {
  const ids = new Set(fileIds);
  const timeline = selectSyncedReadingSessions(sessions, ownerKey);
  let progressPercent = 0;
  let hasReading = false;
  for (const session of timeline) {
    if (!ids.has(session.bookId) || session.completionRoundNumber !== undefined) continue;
    hasReading = true;
    progressPercent = Math.max(progressPercent, session.startProgressPercent, session.endProgressPercent);
  }
  if (!hasReading) return null;
  let totalMs = 0;
  buildReadingStatistics(timeline, {}, ({ session, durationMs }) => {
    if (ids.has(session.bookId)) totalMs += durationMs;
  });
  return { totalMs: Math.round(totalMs), progressPercent };
}

export function getWorkReadingTitles({
  ownerKey, books, progress, bookmarkProgress, sessions, archived,
}: {
  ownerKey: OwnerKey;
  books: readonly Book[];
  progress: Readonly<Record<string, UserProgress>>;
  bookmarkProgress: Readonly<Record<string, UserProgress>>;
  sessions: readonly StoredReadingSessionV11[];
  archived?: PublishedReadingFiles | null;
}) {
  const titles = new Set(visibleReadingSessions(sessions, ownerKey).map(({ bookTitle }) => bookTitle));
  if (archived) for (const file of archived.files) for (const title of file.titles) titles.add(title);
  for (const { id, name } of books) {
    if (progress[id]?.progressPercent > 0 || bookmarkProgress[id]?.bookmarks?.some(({ type }) => type === 'manual')) titles.add(name);
  }
  return [...titles];
}

export function buildPersonalBookReading({
  ownerKey, titleKeys, platformWorkKeys = [], metadataByTitle, uncertainTitles, knownFileIds, books, progress, bookmarkProgress = progress, sessions, archived,
}: {
  ownerKey: OwnerKey;
  titleKeys: readonly string[];
  platformWorkKeys?: readonly string[];
  metadataByTitle?: ReadonlyMap<string, PublicBookMetadata | null>;
  uncertainTitles?: ReadonlySet<string>;
  knownFileIds: readonly string[];
  books: readonly Book[];
  progress: Readonly<Record<string, UserProgress>>;
  bookmarkProgress?: Readonly<Record<string, UserProgress>>;
  sessions: readonly StoredReadingSessionV11[];
  archived?: PublishedReadingFiles | null;
}): PersonalBookReading {
  const published = archived;
  const aliases = new Set(titleKeys.flatMap(getPublicBookMetadataAliasCandidates));
  const works = [...(metadataByTitle?.values() ?? [])].filter((metadata) => metadata !== null);
  const workIds = new Map(works.map((metadata, index) => [metadata, String(index)]));
  const { findTitle } = groupPublicBookWorks([
    { titleKey: 'detail', platformWorkKeys },
    ...works.map((metadata) => ({ titleKey: workIds.get(metadata)!, platformWorkKeys: getPlatformWorkKeys(metadata) })),
  ]);
  const matchedFiles = new Set<string>();
  const identifiedFiles = new Set<string>();
  const conflicts = new Set<string>();
  const uncertainFiles = new Set<string>();
  const detailRoot = findTitle('detail');
  const matchesByTitle = new Map<string, 'matching' | 'conflicting' | 'unknown'>();
  const resolveFile = (id: string, title: string) => {
    if (uncertainTitles?.has(title)) {
      uncertainFiles.add(id);
      return;
    }
    let match = matchesByTitle.get(title);
    if (!match) {
      const metadata = metadataByTitle?.get(title);
      if (metadata && platformWorkKeys.length && metadata.platforms.length) {
        match = detailRoot === findTitle(workIds.get(metadata)!) ? 'matching' : 'conflicting';
      } else if (getPublicBookMetadataAliasCandidates(metadata?.titleKey ?? title).some((alias) => aliases.has(alias))) {
        match = 'matching';
      } else {
        match = metadata ? 'conflicting' : 'unknown';
      }
      matchesByTitle.set(title, match);
    }
    if (match !== 'unknown') identifiedFiles.add(id);
    if (match === 'matching') matchedFiles.add(id);
    if (match === 'conflicting') conflicts.add(id);
  };
  const visible = visibleReadingSessions(sessions, ownerKey);
  for (const { id, name } of books) resolveFile(id, name);
  for (const { bookId, bookTitle } of visible) resolveFile(bookId, bookTitle);
  for (const { fileId, titles } of published?.files ?? []) for (const name of titles) resolveFile(fileId, name);
  // The read list's remembered file IDs support private display only. A
  // matched name for the same file can identify a session under an old name.
  const synced = visible.filter(({ syncState }) => syncState === 'synced');
  const evidenceIds = [...synced.map(({ bookId }) => bookId), ...(published?.files.map(({ fileId }) => fileId) ?? [])];
  const reviewHistoryPartial = evidenceIds.some((id) => !identifiedFiles.has(id) || uncertainFiles.has(id));
  const targetConflict = evidenceIds.some((id) => matchedFiles.has(id) && (conflicts.has(id) || uncertainFiles.has(id)));
  const reviewFileIds = targetConflict ? null : [...matchedFiles].filter((id) => !conflicts.has(id) && !uncertainFiles.has(id));
  const fileIds = new Set([...knownFileIds, ...matchedFiles].filter((id) => !conflicts.has(id)));
  if (fileIds.size === 0) return { bookmarks: [], totalMs: 0, progressPercent: 0, fileIds: [], reviewFileIds, reviewHistoryPartial, hasRead: false };

  const bookmarks = new Map<string, Bookmark>();
  let hasRead = false;
  for (const id of fileIds) {
    if ((progress[id]?.progressPercent ?? 0) > 0) hasRead = true;
    for (const bookmark of bookmarkProgress[id]?.bookmarks ?? []) {
      if (bookmark.type !== 'manual') continue;
      const previous = bookmarks.get(bookmark.id);
      if (!previous || bookmark.createdAt > previous.createdAt) bookmarks.set(bookmark.id, bookmark);
    }
  }

  let totalMs = 0;
  const intervals: Range[] = [];
  const seen = new Set<string>();
  const timeline = visible.filter(({ sessionId }) => {
    if (seen.has(sessionId)) return false;
    seen.add(sessionId);
    return true;
  });
  if (published) {
    for (const file of extendPublishedReadingFiles(published, timeline)) {
      if (!fileIds.has(file.fileId)) continue;
      hasRead = true;
      totalMs += file.unfilteredMs;
      intervals.push(...file.progressIntervals);
    }
  } else {
    // Keep the full timeline for the same overlap attribution used by the statistics page.
    buildReadingStatistics(timeline, {}, ({ session, durationMs }) => {
      if (fileIds.has(session.bookId)) totalMs += durationMs;
    });
    for (const session of timeline) {
      if (!fileIds.has(session.bookId)) continue;
      hasRead = true;
      const { startProgressPercent: start, endProgressPercent: end } = session;
      if (start !== end) intervals.push([Math.min(start, end), Math.max(start, end)]);
    }
  }

  const ranges: Range[] = [];
  for (const interval of intervals.sort(([a], [b]) => a - b)) {
    const previous = ranges.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else ranges.push([...interval]);
  }
  const progressPercent = ranges.reduce((highest, [start, end]) =>
    end + 1e-9 >= start + 2 ? Math.max(highest, end) : highest, 0);
  return { bookmarks: [...bookmarks.values()].sort((a, b) => b.createdAt - a.createdAt), totalMs, progressPercent, fileIds: [...fileIds], reviewFileIds, reviewHistoryPartial, hasRead };
}
