import type { Book, Bookmark, UserProgress } from '../types';
import type { OwnerKey } from './ownerIdentity';
import { getPublicBookMetadataAliasCandidates, type PublicBookMetadata } from './publicBookMetadataSchema';
import { getPlatformWorkKeys, groupPublicBookWorks } from './readBooks';
import { buildReadingStatistics, type StoredReadingSessionV11 } from './readingStatistics';

export const bookDetailHref = (bookId: string) => `#mypage/book/${encodeURIComponent(bookId)}`;

export function readBookDetailId(hash: string) {
  const prefix = '#mypage/book/';
  if (!hash.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(hash.slice(prefix.length));
    return isBookDetailId(id) ? id : null;
  } catch {
    return null;
  }
}

export const isBookDetailId = (id: unknown): id is string =>
  typeof id === 'string' && id.length <= 500 && id.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(id);

type Range = [number, number];
export type PersonalBookReading = { bookmarks: Bookmark[]; totalMs: number; ranges: Range[]; hasRead: boolean };

const visibleReadingSessions = (sessions: readonly StoredReadingSessionV11[], ownerKey: OwnerKey, hidden: ReadonlySet<string>) => (
  sessions.filter((session) => session.ownerKey === ownerKey
    && !hidden.has(session.sessionId) && session.completionRoundNumber === undefined)
);

export function getWorkReadingTitles({
  ownerKey, books, progress, bookmarkProgress, sessions, hidden,
}: {
  ownerKey: OwnerKey;
  books: readonly Book[];
  progress: Readonly<Record<string, UserProgress>>;
  bookmarkProgress: Readonly<Record<string, UserProgress>>;
  sessions: readonly StoredReadingSessionV11[];
  hidden: ReadonlySet<string>;
}) {
  const titles = new Set(visibleReadingSessions(sessions, ownerKey, hidden).map(({ bookTitle }) => bookTitle));
  for (const { id, name } of books) {
    if (progress[id]?.progressPercent > 0 || bookmarkProgress[id]?.bookmarks?.some(({ type }) => type === 'manual')) titles.add(name);
  }
  return [...titles];
}

export function buildPersonalBookReading({
  ownerKey, titleKeys, platformWorkKeys = [], metadataByTitle, knownFileIds, books, progress, bookmarkProgress = progress, sessions, hidden,
}: {
  ownerKey: OwnerKey;
  titleKeys: readonly string[];
  platformWorkKeys?: readonly string[];
  metadataByTitle?: ReadonlyMap<string, PublicBookMetadata | null>;
  knownFileIds: readonly string[];
  books: readonly Book[];
  progress: Readonly<Record<string, UserProgress>>;
  bookmarkProgress?: Readonly<Record<string, UserProgress>>;
  sessions: readonly StoredReadingSessionV11[];
  hidden: ReadonlySet<string>;
}): PersonalBookReading {
  const aliases = new Set(titleKeys.flatMap(getPublicBookMetadataAliasCandidates));
  const works = [...(metadataByTitle?.values() ?? [])].flatMap((metadata) => metadata ? [{
    titleKey: metadata.titleKey, platformWorkKeys: getPlatformWorkKeys(metadata),
  }] : []);
  for (const titleKey of titleKeys) works.push({ titleKey, platformWorkKeys: [...platformWorkKeys] });
  const { findTitle } = groupPublicBookWorks(works);
  const roots = new Set(titleKeys.map(findTitle));
  const matches = (title: string) => {
    const metadata = metadataByTitle?.get(title);
    if (metadata) return roots.has(findTitle(metadata.titleKey));
    return getPublicBookMetadataAliasCandidates(title).some((alias) => aliases.has(alias));
  };
  const fileIds = new Set(knownFileIds);
  const visible = visibleReadingSessions(sessions, ownerKey, hidden);
  for (const { id, name } of books) if (matches(name)) fileIds.add(id);
  for (const { bookId, bookTitle } of visible) if (!fileIds.has(bookId) && matches(bookTitle)) fileIds.add(bookId);
  if (fileIds.size === 0) return { bookmarks: [], totalMs: 0, ranges: [], hasRead: false };

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

  const ranges: Range[] = [];
  for (const interval of intervals.sort(([a], [b]) => a - b)) {
    const previous = ranges.at(-1);
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1]);
    else ranges.push(interval);
  }
  return { bookmarks: [...bookmarks.values()].sort((a, b) => b.createdAt - a.createdAt), totalMs, ranges, hasRead };
}
