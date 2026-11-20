import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import { getPublicBookCoverCandidates, type PublicBookMetadata } from './publicBookMetadataSchema';
import { buildReadingStatistics, type StoredReadingSessionV11 } from './readingStatistics';

export type ReadBook = {
  id: string;
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

export function buildReadBooks(
  sessions: readonly StoredReadingSessionV11[],
  metadataByTitle: ReadonlyMap<string, PublicBookMetadata | null>,
): ReadBook[] {
  const works = [...metadataByTitle.values()].flatMap((metadata) => metadata ? [{
    titleKey: metadata.titleKey, platformWorkKeys: getPlatformWorkKeys(metadata),
  }] : []);
  const { findTitle, aliases } = groupPublicBookWorks(works);
  const equivalentKeys = new Map<string, string[]>();
  for (const key of aliases) {
    const root = findTitle(key);
    const keys = equivalentKeys.get(root) ?? [];
    keys.push(key);
    equivalentKeys.set(root, keys);
  }
  const platformKeys = new Map<string, Set<string>>();
  for (const work of works) {
    const root = findTitle(work.titleKey);
    const keys = platformKeys.get(root) ?? new Set<string>();
    for (const key of work.platformWorkKeys) keys.add(key);
    platformKeys.set(root, keys);
  }
  // Try alternate recorded names for the same file when its latest name did not match.
  const metadataByFile = new Map<string, PublicBookMetadata>();
  const canonicalMetadata = new Map<string, PublicBookMetadata>();
  for (const session of sessions) {
    const metadata = metadataByTitle.get(session.bookTitle);
    if (!metadata) continue;
    metadataByFile.set(session.bookId, metadata);
    const titleKey = findTitle(metadata.titleKey);
    if (!canonicalMetadata.has(titleKey) || titleKey === metadata.titleKey) canonicalMetadata.set(titleKey, metadata);
  }

  const details = new Map<string, { lastReadAt: number; progressPercent: number; fileIds: Set<string> }>();
  const unique = new Set<string>();
  const unmatchedIds = new Map<string, string>();
  // Count overlaps with the same algorithm that powers reading statistics.
  // Keep unmatched sessions in the timeline so overlaps with them are still accounted for.
  const mapped = sessions.flatMap((session) => {
    if (unique.has(session.sessionId)) return [];
    unique.add(session.sessionId);
    const metadata = metadataByTitle.get(session.bookTitle) ?? metadataByFile.get(session.bookId);
    if (!metadata) {
      const id = unmatchedIds.get(session.bookId) ?? `file:${unmatchedIds.size}`;
      unmatchedIds.set(session.bookId, id);
      return [{ ...session, bookId: id }];
    }
    const id = `catalog:${findTitle(metadata.titleKey)}`;
    if (session.completionRoundNumber === undefined) {
      const previous = details.get(id);
      const fileIds = previous?.fileIds ?? new Set<string>();
      fileIds.add(session.bookId);
      details.set(id, {
        lastReadAt: Math.max(previous?.lastReadAt ?? 0, session.endedAtClient),
        progressPercent: Math.max(previous?.progressPercent ?? 0, session.startProgressPercent, session.endProgressPercent),
        fileIds,
      });
    }
    return [{ ...session, bookId: id, bookTitle: metadata.displayTitle }];
  });

  return buildReadingStatistics(mapped).books.flatMap((book) => {
    const reading = details.get(book.bookId);
    if (!reading) return [];
    const id = book.bookId.slice('catalog:'.length);
    const metadata = canonicalMetadata.get(id)!;
    return [{
      id,
      equivalentTitleKeys: equivalentKeys.get(id),
      platformWorkKeys: [...(platformKeys.get(id) ?? [])].sort(),
      title: metadata.displayTitle,
      coverUrl: getPublicBookCoverCandidates(metadata)[0]?.coverUrl ?? null,
      totalMs: book.totalMs,
      lastReadAt: reading.lastReadAt,
      progressPercent: reading.progressPercent,
      fileIds: [...reading.fileIds],
    }];
  }).sort((a, b) => b.lastReadAt - a.lastReadAt || a.title.localeCompare(b.title, 'ko'));
}
