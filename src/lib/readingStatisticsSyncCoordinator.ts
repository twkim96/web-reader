import type {
  QuarantinedReadingStatisticsDocumentV12,
  ReadingStatisticsRemoteCursorV12,
} from './localReadingStatistics';
import type { ReadingSessionV1 } from './readingStatistics';

const UPLOAD_ATTEMPTS_BETWEEN_HYDRATION_PAGES = 4;

export type ReadingStatisticsHydrationPage = {
  sessions: readonly ReadingSessionV1[];
  quarantinedDocuments: readonly QuarantinedReadingStatisticsDocumentV12[];
  nextCursor: ReadingStatisticsRemoteCursorV12 | null;
  fullHydrationCompleted: boolean;
  remoteReadAttemptCount?: number;
  remoteReadCount?: number;
};

export type ReadingStatisticsHydrationRunResult = {
  status: 'completed' | 'lost-leadership';
  cursor: ReadingStatisticsRemoteCursorV12 | null;
  hydratedCount: number;
  quarantinedCount: number;
  pageCount: number;
  remoteReadAttemptCount: number;
  remoteReadCount: number;
};

type ReadingStatisticsHydrationOperations = {
  isLeader: () => boolean | Promise<boolean>;
  fetchPage: (
    cursor: ReadingStatisticsRemoteCursorV12 | null,
    options?: { singleSnapshot: boolean },
  ) => Promise<ReadingStatisticsHydrationPage>;
  commitPage: (
    page: ReadingStatisticsHydrationPage,
    expectedCursor: ReadingStatisticsRemoteCursorV12 | null,
  ) => Promise<{ quarantinedDocuments: readonly unknown[] }>;
};

export const catchUpReadingStatisticsAuditAsLeader = async (
  cursor: ReadingStatisticsRemoteCursorV12,
  { isLeader, verifyPreviousRange, fetchPage, commitPage }: ReadingStatisticsHydrationOperations & {
    verifyPreviousRange: () => Promise<boolean>;
  },
) => {
  // The new tail could otherwise hide a deleted old marker even if the count matches.
  if (!await isLeader() || !await verifyPreviousRange() || !await isLeader()) return 0;
  const page = await fetchPage(cursor, { singleSnapshot: true });
  // Only try a short, clean tail. A weekly audit still has to certify the new
  // checkpoint, including the local count, after this ordinary page commit.
  if (!page.fullHydrationCompleted || !page.sessions.length || page.quarantinedDocuments.length
    || !await isLeader()) return 0;
  await commitPage(page, cursor);
  return page.sessions.length;
};

export const runReadingStatisticsHydrationAsLeader = async ({
  initialCursor,
  isLeader,
  fetchPage,
  commitPage,
  uploadBetweenPages,
}: ReadingStatisticsHydrationOperations & {
  initialCursor: ReadingStatisticsRemoteCursorV12 | null;
  uploadBetweenPages?: (limit: number) => Promise<void>;
}): Promise<ReadingStatisticsHydrationRunResult> => {
  let cursor = initialCursor;
  let hydratedCount = 0;
  let quarantinedCount = 0;
  let pageCount = 0;
  let remoteReadAttemptCount = 0;
  let remoteReadCount = 0;
  while (true) {
    if (!await isLeader()) {
      return {
        status: 'lost-leadership',
        cursor,
        hydratedCount,
        quarantinedCount,
        pageCount,
        remoteReadAttemptCount,
        remoteReadCount,
      };
    }
    const page = await fetchPage(cursor);
    remoteReadAttemptCount += page.remoteReadAttemptCount ?? page.remoteReadCount ?? 1;
    remoteReadCount += page.remoteReadCount ?? 1;
    if (!await isLeader()) {
      return {
        status: 'lost-leadership',
        cursor,
        hydratedCount,
        quarantinedCount,
        pageCount,
        remoteReadAttemptCount,
        remoteReadCount,
      };
    }
    const result = await commitPage(page, cursor);
    pageCount += 1;
    hydratedCount += page.sessions.length;
    quarantinedCount = result.quarantinedDocuments.length;
    cursor = page.nextCursor;
    if (!await isLeader()) {
      return {
        status: 'lost-leadership',
        cursor,
        hydratedCount,
        quarantinedCount,
        pageCount,
        remoteReadAttemptCount,
        remoteReadCount,
      };
    }
    if (page.fullHydrationCompleted) {
      return {
        status: 'completed',
        cursor,
        hydratedCount,
        quarantinedCount,
        pageCount,
        remoteReadAttemptCount,
        remoteReadCount,
      };
    }
    if (uploadBetweenPages) await uploadBetweenPages(UPLOAD_ATTEMPTS_BETWEEN_HYDRATION_PAGES);
  }
};
