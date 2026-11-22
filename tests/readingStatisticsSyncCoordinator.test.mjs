import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadingStatisticsReceiveSchedule } from '../src/lib/readingStatisticsReceiveSchedule.ts';
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

test('commits the first page before any upload and sends queued sessions before the final page', async () => {
  const queued = Array.from({ length: 40 }, (_, index) => session(index));
  const sent = [];
  let sentAtLastFetch = 0;
  const commits = [];
  const nextCursors = [cursor(1, 'remote-1'), cursor(2, 'remote-2'), cursor(3, 'remote-3')];
  const result = await runReadingStatisticsHydrationAsLeader({
    initialCursor: null,
    isLeader: () => true,
    fetchPage: async (current) => {
      const pageIndex = commits.length;
      assert.deepEqual(current, nextCursors[pageIndex - 1] ?? null);
      if (pageIndex === 0) assert.equal(sent.length, 0);
      if (pageIndex > 0) {
        assert.ok(sent.length > sentAtLastFetch, 'uploads must progress between remote pages');
        assert.ok(queued.length > 0, 'a full upload queue must not delay the next remote page');
      }
      sentAtLastFetch = sent.length;
      return {
        sessions: [{ sessionId: nextCursors[pageIndex].documentId }],
        quarantinedDocuments: [],
        nextCursor: nextCursors[pageIndex],
        fullHydrationCompleted: pageIndex === nextCursors.length - 1,
      };
    },
    commitPage: async (page) => {
      commits.push(page.nextCursor);
      return { quarantinedDocuments: [] };
    },
    uploadBetweenPages: async (limit) => {
      assert.ok(commits.length > 0 && commits.length < nextCursors.length);
      for (const pending of queued.splice(0, limit)) sent.push(pending.sessionId);
    },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(commits, nextCursors);
  assert.equal(result.pageCount, 3);
  assert.equal(result.remoteReadCount, 3);
  assert.ok(sent.length > 0 && queued.length > 0);
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
      fullHydrationCompleted: false,
      remoteReadCount: 1,
    }),
    commitPage: async () => {
      leader = false;
      return { quarantinedDocuments: [] };
    },
    uploadBetweenPages: async () => assert.fail('a former leader must not run an upload batch'),
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

test('empty statistics syncs back off while a new record resumes prompt polling', () => {
  const schedule = createReadingStatisticsReceiveSchedule();
  const minute = 60_000;
  let now = 0;
  assert.equal(schedule.pollDue(now), true);
  schedule.complete(now, false);
  const checks = [now];
  while (now < 60 * minute) {
    now += schedule.nextPollDelay(now);
    assert.equal(schedule.pollDue(now), true);
    schedule.complete(now, false);
    checks.push(now);
  }
  assert.deepEqual(checks.map((time) => time / minute), [0, 2, 7, 17, 27, 37, 47, 57, 67]);

  schedule.complete(now, true);
  assert.equal(schedule.pollDue(now + minute - 1), false);
  assert.equal(schedule.pollDue(now + minute), true);
});

test('a check by the other tab postpones passive wake without requiring another query', () => {
  const schedule = createReadingStatisticsReceiveSchedule();
  schedule.observeCheck(10_000);
  schedule.observeCheck(7_000);
  assert.equal(schedule.wakeDue(69_999), false);
  assert.equal(schedule.pollDue(69_999), false);
  assert.equal(schedule.wakeDue(70_000), true);
});

test('a tab taking over after a peer receives records uses the normal polling interval', () => {
  const schedule = createReadingStatisticsReceiveSchedule();
  schedule.complete(0, false);
  schedule.complete(120_000, false);
  schedule.complete(420_000, false);
  assert.equal(schedule.nextPollDelay(420_000), 600_000);

  schedule.observeCheck(500_000, true);
  // A delayed empty result cannot reapply backoff to the newer check.
  schedule.observeCheck(490_000, false);
  assert.equal(schedule.wakeDue(530_000), false);
  assert.equal(schedule.pollDue(560_000), true);
});
