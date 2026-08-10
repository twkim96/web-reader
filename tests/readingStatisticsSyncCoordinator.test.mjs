import test from 'node:test';
import assert from 'node:assert/strict';

import { runReadingStatisticsHydrationAsLeader } from '../src/lib/readingStatisticsSyncCoordinator.ts';

const cursor = (seconds, documentId) => ({
  uploadedAtServerSeconds: seconds,
  uploadedAtServerNanoseconds: 0,
  documentId,
});

const session = (index) => ({ sessionId: `session-${index}` });

test('hydrates 500-record pages under one leader and preserves the exact cursor chain', async () => {
  const pages = [
    {
      sessions: Array.from({ length: 500 }, (_, index) => session(index)),
      quarantinedDocuments: [],
      nextCursor: cursor(1, 'session-499'),
      fullHydrationCompleted: false,
    },
    {
      sessions: Array.from({ length: 500 }, (_, index) => session(index + 500)),
      quarantinedDocuments: [],
      nextCursor: cursor(2, 'session-999'),
      fullHydrationCompleted: false,
    },
    {
      sessions: [session(1000)],
      quarantinedDocuments: [],
      nextCursor: cursor(3, 'session-1000'),
      fullHydrationCompleted: true,
    },
  ];
  const fetchCursors = [];
  const commitCursors = [];
  const result = await runReadingStatisticsHydrationAsLeader({
    initialCursor: null,
    isLeader: () => true,
    fetchPage: async (current) => {
      fetchCursors.push(current);
      return pages.shift();
    },
    commitPage: async (page, expectedCursor) => {
      commitCursors.push(expectedCursor);
      return { quarantinedDocuments: page.quarantinedDocuments };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.hydratedCount, 1001);
  assert.equal(result.remoteReadAttemptCount, 3);
  assert.deepEqual(result.cursor, cursor(3, 'session-1000'));
  assert.deepEqual(fetchCursors, [null, cursor(1, 'session-499'), cursor(2, 'session-999')]);
  assert.deepEqual(commitCursors, fetchCursors);
});

test('drops a fetched page when leadership changes before its local commit', async () => {
  let leader = true;
  let fetches = 0;
  let commits = 0;
  const firstCursor = cursor(1, 'session-499');
  const result = await runReadingStatisticsHydrationAsLeader({
    initialCursor: null,
    isLeader: () => leader,
    fetchPage: async () => {
      fetches += 1;
      if (fetches === 1) {
        return {
          sessions: Array.from({ length: 500 }, (_, index) => session(index)),
          quarantinedDocuments: [],
          nextCursor: firstCursor,
          fullHydrationCompleted: false,
        };
      }
      leader = false;
      return {
        sessions: [session(500)],
        quarantinedDocuments: [],
        nextCursor: cursor(2, 'session-500'),
        fullHydrationCompleted: true,
      };
    },
    commitPage: async (page) => {
      commits += 1;
      return { quarantinedDocuments: page.quarantinedDocuments };
    },
  });
  assert.equal(result.status, 'lost-leadership');
  assert.equal(fetches, 2);
  assert.equal(commits, 1);
  assert.equal(result.hydratedCount, 500);
  assert.equal(result.remoteReadAttemptCount, 2);
  assert.equal(result.remoteReadCount, 2);
  assert.deepEqual(result.cursor, firstCursor);
});

test('reports a page committed immediately before leadership loss', async () => {
  let leader = true;
  const nextCursor = cursor(1, 'session-1');
  const result = await runReadingStatisticsHydrationAsLeader({
    initialCursor: null,
    isLeader: () => leader,
    fetchPage: async () => ({
      sessions: [session(1)],
      quarantinedDocuments: [],
      nextCursor,
      fullHydrationCompleted: true,
      remoteReadCount: 1,
    }),
    commitPage: async () => {
      leader = false;
      return { quarantinedDocuments: [] };
    },
  });

  assert.equal(result.status, 'lost-leadership');
  assert.equal(result.remoteReadAttemptCount, 1);
  assert.equal(result.remoteReadCount, 1);
  assert.equal(result.pageCount, 1);
  assert.equal(result.hydratedCount, 1);
  assert.deepEqual(result.cursor, nextCursor);
});

test('counts every internal remote query used by one logical page', async () => {
  const result = await runReadingStatisticsHydrationAsLeader({
    initialCursor: null,
    isLeader: () => true,
    fetchPage: async () => ({
      sessions: [session(1)],
      quarantinedDocuments: [],
      nextCursor: cursor(1, 'session-1'),
      fullHydrationCompleted: true,
      remoteReadAttemptCount: 2,
      remoteReadCount: 2,
    }),
    commitPage: async () => ({ quarantinedDocuments: [] }),
  });
  assert.equal(result.pageCount, 1);
  assert.equal(result.remoteReadAttemptCount, 2);
  assert.equal(result.remoteReadCount, 2);
});
