import type {
  QuarantinedReadingStatisticsDocumentV12,
  ReadingStatisticsRemoteCursorV12,
} from './localReadingStatistics';
import type { ReadingSessionV1 } from './readingStatistics';

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

export const runReadingStatisticsHydrationAsLeader = async ({
  initialCursor,
  isLeader,
  fetchPage,
  commitPage,
}: {
  initialCursor: ReadingStatisticsRemoteCursorV12 | null;
  isLeader: () => boolean | Promise<boolean>;
  fetchPage: (
    cursor: ReadingStatisticsRemoteCursorV12 | null,
  ) => Promise<ReadingStatisticsHydrationPage>;
  commitPage: (
    page: ReadingStatisticsHydrationPage,
    expectedCursor: ReadingStatisticsRemoteCursorV12 | null,
  ) => Promise<{ quarantinedDocuments: readonly unknown[] }>;
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
  }
};
