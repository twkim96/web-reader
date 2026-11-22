import { measureMyPageWork } from './myPagePerformance';
import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import { getPublicBookCoverCandidates, type PublicBookMetadata } from './publicBookMetadataSchema';
import { buildReadingStatistics, type StoredReadingSessionV11 } from './readingStatistics';

export type ReadBook = {
  id: string;
  rowKey?: string;
  fileIds?: string[];
  equivalentTitleKeys?: string[];
  platformWorkKeys?: string[];
  title: string;
  coverUrl: string | null;
  totalMs: number;
  progressPercent: number;
  lastReadAt: number;
};

export const selectSyncedReadingSessions = (
  sessions: readonly StoredReadingSessionV11[],
  ownerKey: OwnerKey,
  hidden: ReadonlySet<string>,
) => isGuestOwner(ownerKey) ? [] : sessions.filter((session) => (
  session.ownerKey === ownerKey && session.syncState === 'synced' && !hidden.has(session.sessionId)
));

export const platformWorkKey = (platform: string, url: string) => JSON.stringify([platform, url]);
export const getPlatformWorkKeys = ({ platforms }: Pick<PublicBookMetadata, 'platforms'>) => (
  platforms.map(({ platform, url }) => platformWorkKey(platform, url))
);

export function groupPublicBookWorks(works: Iterable<{ titleKey: string; platformWorkKeys: readonly string[] }>) {
  const parent = new Map<string, string>();
  const platformTitles = new Map<string, string>();
  const findTitle = (key: string): string => {
    let root = key;
    while (parent.has(root)) root = parent.get(root)!;
    while (key !== root) {
      const next = parent.get(key)!;
      parent.set(key, root);
      key = next;
    }
    return root;
  };
  for (const work of works) {
    for (const platformKey of work.platformWorkKeys) {
      const previous = platformTitles.get(platformKey);
      if (!previous) {
        platformTitles.set(platformKey, work.titleKey);
        continue;
      }
      const left = findTitle(previous);
      const right = findTitle(work.titleKey);
      if (left !== right) parent.set(left < right ? right : left, left < right ? left : right);
    }
  }
  return { findTitle, aliases: parent.keys() };
}

export function prepareReadBooks(sessions: readonly StoredReadingSessionV11[]) {
  const ids = new Set<string>();
  const unique = sessions.filter(({ sessionId }) => {
    if (ids.has(sessionId)) return false;
    ids.add(sessionId);
    return true;
  });
  let timeByFile: Map<string, number> | undefined;
  // The winning interval depends on time, device, mode and session ID.
  // Later title/edition matches only change which work receives the file's time.
  const getTimeByFile = () => timeByFile ??= measureMyPageWork('read-books-timeline', () => (
    new Map(buildReadingStatistics(unique).books.map(({ bookId, totalMs }) => [bookId, totalMs]))
  ));
  return (metadata: ReadonlyMap<string, PublicBookMetadata | null>) => (
    buildRows(unique, metadata, getTimeByFile)
  );
}

export function buildReadBooks(
  sessions: readonly StoredReadingSessionV11[],
  metadataByTitle: ReadonlyMap<string, PublicBookMetadata | null>,
): ReadBook[] {
  return prepareReadBooks(sessions)(metadataByTitle);
}

function buildRows(
  sessions: readonly StoredReadingSessionV11[],
  metadataByTitle: ReadonlyMap<string, PublicBookMetadata | null>,
  getTimeByFile: () => ReadonlyMap<string, number>,
): ReadBook[] {
  // Distinct platform editions can share a title key. Give each edition its
  // own node before joining the entries connected by a platform link.
  const works = new Map<PublicBookMetadata, { titleKey: string; platformWorkKeys: string[] }>();
  for (const metadata of metadataByTitle.values()) {
    if (!metadata || works.has(metadata)) continue;
    const platformWorkKeys = getPlatformWorkKeys(metadata).sort();
    works.set(metadata, { titleKey: JSON.stringify([metadata.titleKey, platformWorkKeys]), platformWorkKeys });
  }
  if (!works.size) return [];

  const { findTitle } = groupPublicBookWorks(works.values());
  const groups = new Map<string, { id: string; metadata: PublicBookMetadata; titles: Set<string>; platforms: Set<string> }>();
  const rowKeys = new Map<string, string>();
  for (const [metadata, work] of works) {
    const root = findTitle(work.titleKey);
    const group = groups.get(root) ?? { id: `catalog:${groups.size}`, metadata, titles: new Set(), platforms: new Set() };
    rowKeys.set(group.id, root);
    if (metadata.titleKey < group.metadata.titleKey) group.metadata = metadata;
    group.titles.add(metadata.titleKey);
    for (const key of work.platformWorkKeys) group.platforms.add(key);
    groups.set(root, group);
  }

  // Alternate recorded names identify the file only when they agree on a work.
  const workByFile = new Map<string, string | null>();
  for (const session of sessions) {
    if (!metadataByTitle.has(session.bookTitle)) {
      workByFile.set(session.bookId, null);
      continue;
    }
    const metadata = metadataByTitle.get(session.bookTitle);
    if (!metadata) continue;
    const root = findTitle(works.get(metadata)!.titleKey);
    const previous = workByFile.get(session.bookId);
    workByFile.set(session.bookId, previous === undefined || previous === root ? root : null);
  }

  const details = new Map<string, { lastReadAt: number; progressPercent: number; fileIds: Set<string> }>();
  for (const session of sessions) {
    const root = workByFile.get(session.bookId);
    if (root == null || session.completionRoundNumber !== undefined) continue;
    const { id } = groups.get(root)!;
    const previous = details.get(id);
    const fileIds = previous?.fileIds ?? new Set<string>();
    fileIds.add(session.bookId);
    details.set(id, {
      lastReadAt: Math.max(previous?.lastReadAt ?? 0, session.endedAtClient),
      progressPercent: Math.max(previous?.progressPercent ?? 0, session.startProgressPercent, session.endProgressPercent),
      fileIds,
    });
  }

  const timeByFile = getTimeByFile();
  return [...details.entries()].flatMap(([bookId, reading]) => {
    const files = [...reading.fileIds];
    if (!files.some((file) => timeByFile.has(file))) return [];
    const rowKey = rowKeys.get(bookId)!;
    const { metadata, titles, platforms } = groups.get(rowKey)!;
    const id = metadata.titleKey;
    return [{
      id,
      rowKey,
      equivalentTitleKeys: [...titles].filter((key) => key !== id),
      platformWorkKeys: [...platforms].sort(),
      title: metadata.displayTitle,
      coverUrl: getPublicBookCoverCandidates(metadata)[0]?.coverUrl ?? null,
      totalMs: files.reduce((sum, file) => sum + (timeByFile.get(file) ?? 0), 0),
      lastReadAt: reading.lastReadAt,
      progressPercent: reading.progressPercent,
      fileIds: files,
    }];
  }).sort((a, b) => b.lastReadAt - a.lastReadAt || a.title.localeCompare(b.title, 'ko') || b.totalMs - a.totalMs);
}
