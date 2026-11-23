import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  buildReadingStatistics,
  buildReadingBookRounds,
  createReadingRoundCompletionSession,
  getReadingSessionCommitBoundary,
  getReadingSessionLocalDate,
  getNextReadingTtsTrackingPhase,
  getReadingStatisticsRangeBounds,
  formatReadingClock,
  getReadingTrackingEndAt,
  getNextReadingInteractionFocus,
  getReadingTrackingMode,
  isReadingSessionV1,
  MIN_READING_STATISTICS_BLOCK_MS,
  READING_SESSION_COMMIT_INTERVAL_MS,
  READING_SESSION_MAX_DURATION_MS,
  shouldResetReadingActivityForTtsTransition,
  sortReadingBookRoundsByRecent,
} from '../src/lib/readingStatistics.ts';

// tsx loads the application module and its Firebase dependency as CommonJS.
const { Timestamp } = createRequire(import.meta.url)('firebase/firestore');

test('formats compact reader time as an unlabeled hour-minute clock', () => {
  assert.equal(formatReadingClock(0), '00:00');
  assert.equal(formatReadingClock(59_999), '00:00');
  assert.equal(formatReadingClock(60_000), '00:01');
  assert.equal(formatReadingClock(6_059_999), '01:40');
  assert.equal(formatReadingClock(360_000_000), '100:00');
});

test('merges offline confirmations of one low-progress round without duplicating time', () => {
  const source = session({ sessionId: 'source', startedAtClient: 1_000, endedAtClient: 61_000, startProgressPercent: 20, endProgressPercent: 30 });
  const complete = (records, round, id, at) => {
    const result = createReadingRoundCompletionSession({
      sessions: records, bookId: source.bookId, expectedRoundNumber: round,
      sessionId: id, confirmedAtClient: at,
    });
    assert.equal(result.status, 'created');
    return result.session;
  };
  const a = complete([source], 1, 'completion-a', 62_000);
  const b = complete([source], 1, 'completion-b', 200_000);
  assert.equal(a.completionRoundNumber, 1);
  assert.equal(b.completionRoundNumber, 1);
  for (const records of [[source, a, b], [b, a, source, b]]) {
    const rounds = buildReadingBookRounds(records);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].completed, true);
    assert.equal(rounds[0].totalMs, source.durationMs);
    assert.equal(buildReadingStatistics(records).totalMs, source.durationMs);
    assert.equal(buildReadingStatistics(records).countedSessionCount, 1);
  }

  // A real reread starts after the first confirmation. A delayed offline
  // confirmation still belongs to round one and cannot complete round two.
  const reread = session({
    sessionId: 'reread', startedAtClient: 70_000, endedAtClient: 130_000,
    startProgressPercent: 0, endProgressPercent: 10,
  });
  const records = [source, a, reread, b];
  let rounds = buildReadingBookRounds(records);
  assert.deepEqual(rounds.map(({ completed }) => completed), [true, false]);
  const second = complete(records, 2, 'second-round-completion', 210_000);
  assert.equal(second.completionRoundNumber, 2);
  rounds = buildReadingBookRounds([...records, second]);
  assert.deepEqual(rounds.map(({ completed }) => completed), [true, true]);
  assert.equal(rounds.reduce((total, round) => total + round.totalMs, 0), 120_000);
  assert.equal(buildReadingStatistics([...records, second]).totalMs, 120_000);
});

test('reconciles legacy cloned completion markers against their source interval', () => {
  const source = session({ sessionId: 'source', startedAtClient: 1_000, endedAtClient: 61_000, startProgressPercent: 20, endProgressPercent: 30 });
  const records = [source, ...['legacy-a', 'legacy-b'].map((sessionId, index) => ({
    ...source, sessionId, completed: true, completionConfirmedAtClient: 62_000 + index,
  }))];
  const rounds = buildReadingBookRounds(records);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].totalMs, 60_000);
  assert.equal(rounds[0].completed, true);
});

test('validates logical completion identities and never counts a marker alone as reading', () => {
  const source = session({ sessionId: 'source', startedAtClient: 1_000, endedAtClient: 61_000 });
  const result = createReadingRoundCompletionSession({
    sessions: [source], bookId: source.bookId, expectedRoundNumber: 1,
    sessionId: 'marker-only', confirmedAtClient: 62_000,
  });
  assert.equal(result.status, 'created');
  assert.equal(buildReadingStatistics([result.session]).totalMs, 0);
  assert.equal(isReadingSessionV1({ ...result.session, completionRoundNumber: 0 }), false);
  assert.equal(isReadingSessionV1({ ...result.session, completionRoundNumber: 1.5 }), false);
  assert.equal(isReadingSessionV1({ ...source, completionRoundNumber: 1 }), false);
});

test('preserves logical rounds across marker-first hydration and missing earlier history', () => {
  const first = session({ sessionId: 'first', startedAtClient: 1_000, endedAtClient: 61_000 });
  const complete = (records, roundNumber, id, at) => {
    const result = createReadingRoundCompletionSession({
      sessions: records, bookId: first.bookId, expectedRoundNumber: roundNumber,
      sessionId: id, confirmedAtClient: at,
    });
    assert.equal(result.status, 'created');
    return result.session;
  };
  const marker1 = complete([first], 1, 'marker1', 62_000);
  const second = session({
    sessionId: 'second', startedAtClient: 70_000, endedAtClient: 130_000,
    startProgressPercent: 0, endProgressPercent: 10,
  });
  const marker2 = complete([first, marker1, second], 2, 'marker2', 131_000);
  for (const records of [[marker1, second, marker2], [second, marker2]]) {
    const rounds = buildReadingBookRounds(records);
    assert.deepEqual(rounds.map(({ roundNumber, completed, totalMs }) => (
      { roundNumber, completed, totalMs }
    )), [{ roundNumber: 2, completed: true, totalMs: 60_000 }]);
    assert.equal(createReadingRoundCompletionSession({
      sessions: records, bookId: first.bookId, expectedRoundNumber: 2,
      sessionId: 'duplicate', confirmedAtClient: 132_000,
    }).status, 'already-completed');
  }
  const markerOnly = [marker1, marker2];
  assert.deepEqual(buildReadingBookRounds(markerOnly), []);
  assert.equal(createReadingRoundCompletionSession({
    sessions: markerOnly, bookId: first.bookId, expectedRoundNumber: 2,
    sessionId: 'duplicate', confirmedAtClient: 132_000,
  }).status, 'already-completed');
  const restored = buildReadingBookRounds([marker2, second, marker1, first]);
  assert.deepEqual(restored.map(({ roundNumber, completed, totalMs }) => (
    { roundNumber, completed, totalMs }
  )), [
    { roundNumber: 1, completed: true, totalMs: 60_000 },
    { roundNumber: 2, completed: true, totalMs: 60_000 },
  ]);
  // A huge but schema-valid ordinal must not allocate millions of placeholders.
  const high = { ...marker2, completionRoundNumber: Number.MAX_SAFE_INTEGER };
  assert.equal(buildReadingBookRounds([second, high])[0].roundNumber, Number.MAX_SAFE_INTEGER);
});

test('derives rereading rounds after completion without changing stored sessions', () => {
  const rounds = buildReadingBookRounds([
    session({
      sessionId: 'first-start', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 0, endProgressPercent: 50,
    }),
    session({
      sessionId: 'first-finish', startedAtClient: 62_000, endedAtClient: 122_000,
      startProgressPercent: 50, endProgressPercent: 100, completed: true,
      completionConfirmedAtClient: 122_000,
    }),
    session({
      sessionId: 'finish-linger', startedAtClient: 123_000, endedAtClient: 183_000,
      startProgressPercent: 100, endProgressPercent: 100,
    }),
    session({
      sessionId: 'second-start', startedAtClient: 184_000, endedAtClient: 244_000,
      startProgressPercent: 100, endProgressPercent: 25,
    }),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].roundNumber, 1);
  assert.equal(rounds[0].completed, true);
  assert.equal(rounds[0].totalMs, 180_000);
  assert.equal(rounds[0].completedLocalDate, '1970-01-01');
  assert.equal(rounds[1].roundNumber, 2);
  assert.equal(rounds[1].completed, false);
  assert.equal(rounds[1].totalMs, 60_000);
  assert.equal(rounds[1].startedLocalDate, '1970-01-01');
});

test('keeps rereading rows in round order even when a later round is longer', () => {
  const rounds = buildReadingBookRounds([
    session({
      sessionId: 'short-finish', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 90, endProgressPercent: 100, completed: true,
      completionConfirmedAtClient: 61_000,
    }),
    session({
      sessionId: 'long-second-a', startedAtClient: 62_000, endedAtClient: 122_000,
      startProgressPercent: 0, endProgressPercent: 20,
    }),
    session({
      sessionId: 'long-second-b', startedAtClient: 123_000, endedAtClient: 183_000,
      startProgressPercent: 20, endProgressPercent: 40,
    }),
  ]);
  assert.deepEqual(rounds.map(({ roundNumber }) => roundNumber), [1, 2]);
  assert.deepEqual(
    sortReadingBookRoundsByRecent(rounds).map(({ roundNumber }) => roundNumber),
    [2, 1],
  );
});

test('sorts displayed reading rounds by their latest corrected reading time', () => {
  const rounds = buildReadingBookRounds([
    session({
      sessionId: 'newer-book', bookId: 'newer', bookTitle: 'Newer',
      startedAtClient: 200_000, endedAtClient: 260_000,
    }),
    session({
      sessionId: 'older-book', bookId: 'older', bookTitle: 'Older',
      startedAtClient: 100_000, endedAtClient: 160_000,
    }),
  ]);

  assert.deepEqual(
    sortReadingBookRoundsByRecent(rounds).map(({ bookId }) => bookId),
    ['newer', 'older'],
  );
  assert.deepEqual(
    sortReadingBookRoundsByRecent(rounds).map(({ lastReadAtClient }) => lastReadAtClient),
    [260_000, 160_000],
  );
});

test('restarts an uncompleted hidden round at round one with only new visible sessions', () => {
  const oldSession = session({
    sessionId: 'old-accidental-open', startedAtClient: 1_000, endedAtClient: 61_000,
    startProgressPercent: 0, endProgressPercent: 1,
  });
  const newSession = session({
    sessionId: 'new-reading', startedAtClient: 62_000, endedAtClient: 182_000,
    startProgressPercent: 1, endProgressPercent: 20,
  });
  const rounds = buildReadingBookRounds(
    [oldSession, newSession],
    {},
    new Set([oldSession.sessionId]),
  );

  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].roundNumber, 1);
  assert.equal(rounds[0].totalMs, 120_000);
  assert.deepEqual(rounds[0].sourceSessionIds, ['new-reading']);
});

test('keeps a surviving second round numbered after hiding its completed first round', () => {
  const first = session({
    sessionId: 'completed-first', startedAtClient: 1_000, endedAtClient: 61_000,
    startProgressPercent: 90, endProgressPercent: 99,
  });
  const completion = createReadingRoundCompletionSession({
    sessions: [first],
    bookId: 'book-1',
    expectedRoundNumber: 1,
    sessionId: 'first-completion-marker',
    confirmedAtClient: 62_000,
  });
  assert.equal(completion.status, 'created');
  if (completion.status !== 'created') return;
  const second = session({
    sessionId: 'existing-second', startedAtClient: 63_000, endedAtClient: 123_000,
    startProgressPercent: 99, endProgressPercent: 20,
  });
  const rounds = buildReadingBookRounds(
    [first, completion.session, second],
    {},
    new Set([first.sessionId, completion.session.sessionId]),
  );

  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].roundNumber, 2);
  assert.deepEqual(rounds[0].sourceSessionIds, ['existing-second']);
});

test('numbers reading rounds independently for each book', () => {
  const rounds = buildReadingBookRounds([
    session({
      sessionId: 'book-a-first-finish', bookId: 'book-a', bookTitle: 'Book A',
      startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 0, endProgressPercent: 100, completed: true,
      completionConfirmedAtClient: 61_000,
    }),
    session({
      sessionId: 'book-b-first', bookId: 'book-b', bookTitle: 'Book B',
      startedAtClient: 62_000, endedAtClient: 122_000,
      startProgressPercent: 0, endProgressPercent: 40,
    }),
    session({
      sessionId: 'book-a-second', bookId: 'book-a', bookTitle: 'Book A',
      startedAtClient: 123_000, endedAtClient: 243_000,
      startProgressPercent: 0, endProgressPercent: 25,
    }),
    session({
      sessionId: 'book-c-first', bookId: 'book-c', bookTitle: 'Book C',
      startedAtClient: 244_000, endedAtClient: 304_000,
      startProgressPercent: 0, endProgressPercent: 10,
    }),
  ]);

  const bookARounds = rounds.filter(({ bookId }) => bookId === 'book-a');
  assert.deepEqual(
    bookARounds.map(({ roundNumber, totalMs }) => ({ roundNumber, totalMs })),
    [
      { roundNumber: 1, totalMs: 60_000 },
      { roundNumber: 2, totalMs: 120_000 },
    ],
  );
  assert.deepEqual(
    rounds.filter(({ bookId }) => bookId === 'book-b').map(({ roundNumber }) => roundNumber),
    [1],
  );
  assert.deepEqual(
    rounds.filter(({ bookId }) => bookId === 'book-c').map(({ roundNumber }) => roundNumber),
    [1],
  );
});

test('keeps end-to-start reading in one round until completion is explicitly confirmed', () => {
  const sessions = [
    session({
      sessionId: 'legacy-auto-complete', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 90, endProgressPercent: 100, completed: true,
    }),
    session({
      sessionId: 'back-to-start-without-confirming', startedAtClient: 62_000,
      endedAtClient: 122_000, startProgressPercent: 100, endProgressPercent: 20,
    }),
  ];
  const rounds = buildReadingBookRounds(sessions);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].roundNumber, 1);
  assert.equal(rounds[0].completed, false);
  assert.equal(rounds[0].totalMs, 120_000);
  assert.equal(rounds[0].canComplete, true);
});

test('explicitly completes a partial reading round and starts the next read as a new round', () => {
  const partial = session({
    sessionId: 'partial-reading', startedAtClient: 1_000, endedAtClient: 61_000,
    startProgressPercent: 0, endProgressPercent: 20,
  });
  const completion = createReadingRoundCompletionSession({
    sessions: [partial],
    bookId: 'book-1',
    expectedRoundNumber: 1,
    sessionId: 'partial-completion-marker',
    confirmedAtClient: 62_000,
  });
  assert.equal(completion.status, 'created');
  if (completion.status !== 'created') return;
  assert.equal(completion.session.endProgressPercent, 20);

  const rounds = buildReadingBookRounds([
    partial,
    completion.session,
    session({
      sessionId: 'next-reading', startedAtClient: 63_000, endedAtClient: 123_000,
      startProgressPercent: 20, endProgressPercent: 30,
    }),
  ]);
  assert.deepEqual(rounds.map(({ roundNumber, completed }) => ({ roundNumber, completed })), [
    { roundNumber: 1, completed: true },
    { roundNumber: 2, completed: false },
  ]);
});

test('starts the next round only below 99 percent after explicit completion', () => {
  const beforeCompletion = [
    session({
      sessionId: 'near-end', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 70, endProgressPercent: 99,
    }),
  ];
  const eligible = buildReadingBookRounds(beforeCompletion);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].canComplete, true);
  assert.equal(eligible[0].completed, false);

  const completion = createReadingRoundCompletionSession({
    sessions: beforeCompletion,
    bookId: 'book-1',
    expectedRoundNumber: 1,
    sessionId: 'completion-marker',
    confirmedAtClient: 62_000,
  });
  assert.equal(completion.status, 'created');
  if (completion.status !== 'created') return;

  const lingering = session({
    sessionId: 'still-at-end', startedAtClient: 63_000, endedAtClient: 123_000,
    startProgressPercent: 100, endProgressPercent: 99,
  });
  let rounds = buildReadingBookRounds([...beforeCompletion, completion.session, lingering]);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].completed, true);
  assert.equal(rounds[0].totalMs, 120_000);

  const reread = session({
    sessionId: 'reread-below-threshold', startedAtClient: 124_000, endedAtClient: 184_000,
    startProgressPercent: 99, endProgressPercent: 98.9,
  });
  rounds = buildReadingBookRounds([
    ...beforeCompletion,
    completion.session,
    lingering,
    reread,
  ]);
  assert.deepEqual(rounds.map(({ roundNumber, completed, totalMs }) => ({
    roundNumber,
    completed,
    totalMs,
  })), [
    { roundNumber: 1, completed: true, totalMs: 120_000 },
    { roundNumber: 2, completed: false, totalMs: 60_000 },
  ]);
});

test('keeps every session before the completion confirmation in the closing round', () => {
  const sessions = [
    session({
      sessionId: 'first-near-end', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 70, endProgressPercent: 99,
    }),
    session({
      sessionId: 'pre-confirmation-reread', startedAtClient: 62_000, endedAtClient: 122_000,
      startProgressPercent: 99, endProgressPercent: 20,
    }),
    session({
      sessionId: 'back-at-end', startedAtClient: 123_000, endedAtClient: 183_000,
      startProgressPercent: 20, endProgressPercent: 99,
    }),
  ];
  const completion = createReadingRoundCompletionSession({
    sessions,
    bookId: 'book-1',
    expectedRoundNumber: 1,
    sessionId: 'late-completion-marker',
    confirmedAtClient: 200_000,
  });
  assert.equal(completion.status, 'created');
  if (completion.status !== 'created') return;
  const beforeNewReading = buildReadingBookRounds([...sessions, completion.session]);
  assert.equal(beforeNewReading.length, 1);
  assert.equal(beforeNewReading[0].completed, true);
  assert.equal(beforeNewReading[0].totalMs, 180_000);

  const afterNewReading = buildReadingBookRounds([
    ...sessions,
    completion.session,
    session({
      sessionId: 'post-confirmation-reread', startedAtClient: 201_000, endedAtClient: 261_000,
      startProgressPercent: 99, endProgressPercent: 20,
    }),
  ]);
  assert.deepEqual(afterNewReading.map(({ roundNumber, totalMs }) => ({
    roundNumber,
    totalMs,
  })), [
    { roundNumber: 1, totalMs: 180_000 },
    { roundNumber: 2, totalMs: 60_000 },
  ]);
});

test('omits reading rounds with no counted time in the selected date range', () => {
  const rounds = buildReadingBookRounds([
    session({
      sessionId: 'old-reading', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 0, endProgressPercent: 20,
    }),
  ], {
    startLocalDate: '1970-01-02',
    endLocalDate: '1970-01-02',
  });
  assert.deepEqual(rounds, []);
});
import { createReadingStatisticsJsonExport } from '../src/lib/readingStatisticsExport.ts';
import { prepareLocalReadingReport } from '../src/lib/readingStatisticsReport.ts';
import { hasPublishedBoundaryClockRisk, mergePublishedCalendarDays } from '../src/lib/readingRollupCalendar.ts';
import {
  getRemoteReadingSessionsPageV1,
  readReadingStatisticsClockSampleV1,
  readReadingStatisticsClockSampleSingleFlight,
  verifyRemoteReadingStatisticsAuditV1,
  verifyLegacyReadingStatisticsCursorV1,
} from '../src/lib/readingStatisticsSync.ts';
import {
  detachReadingActivityTargets,
  reconcileReadingActivityTargets,
} from '../src/lib/readingActivityTargets.ts';

const session = ({
  sessionId,
  bookId = 'book-1',
  bookTitle = 'Book One',
  deviceId = 'device-1',
  mode = 'screen',
  startedAtClient,
  endedAtClient,
  startProgressPercent = 10,
  endProgressPercent = 20,
  timezoneOffsetMinutes = 0,
  completed = false,
  clockOffsetMs = 0,
  durationMs,
  activeIntervals,
  completionConfirmedAtClient,
}) => ({
  schemaVersion: 1,
  sessionId,
  bookId,
  bookTitle,
  deviceId,
  mode,
  startedAtClient,
  endedAtClient,
  durationMs: durationMs ?? endedAtClient - startedAtClient,
  startProgressPercent,
  endProgressPercent,
  timezoneOffsetMinutes,
  localDate: getReadingSessionLocalDate(startedAtClient, timezoneOffsetMinutes),
  completed,
  ...(completionConfirmedAtClient === undefined ? {} : { completionConfirmedAtClient }),
  ...(activeIntervals ? { activeIntervals } : {}),
  ...(clockOffsetMs === null ? {} : {
    clockOffsetMs,
    clockUncertaintyMs: 25,
    clockMeasuredAtClient: startedAtClient,
  }),
});

test('validates bounded immutable reading session payloads', () => {
  const valid = session({ sessionId: 'session-a', startedAtClient: 1_000, endedAtClient: 61_000 });
  assert.equal(isReadingSessionV1(valid), true);
  assert.equal(isReadingSessionV1({ ...valid, durationMs: 59_999 }), false);
  assert.equal(isReadingSessionV1({ ...valid, endedAtClient: 301_001, durationMs: 300_001 }), false);
  assert.equal(isReadingSessionV1({ ...valid, localDate: '2026-99-99' }), false);
  assert.equal(isReadingSessionV1({ ...valid, sessionId: 'bad/id' }), false);
});

test('uses five-minute screen and one-minute TTS boundaries, limited by midnight', () => {
  assert.equal(READING_SESSION_COMMIT_INTERVAL_MS, 300_000);
  assert.equal(READING_SESSION_MAX_DURATION_MS, 300_000);
  assert.equal(getReadingSessionCommitBoundary(1_000, 0), 301_000);
  assert.equal(getReadingSessionCommitBoundary(1_000, 0, 'tts'), 61_000);
  assert.equal(getReadingSessionCommitBoundary(
    Date.UTC(2026, 7, 12, 14, 59, 30),
    -540,
  ), Date.UTC(2026, 7, 12, 15, 0, 0));
  assert.equal(isReadingSessionV1(session({
    sessionId: 'legacy-five-minute-session',
    startedAtClient: 1_000,
    endedAtClient: 301_000,
  })), true);
});

test('deduplicates overlapping devices and gives TTS deterministic priority', () => {
  const sessions = [
    session({ sessionId: 'a', startedAtClient: 1_000, endedAtClient: 61_000 }),
    session({
      sessionId: 'b', deviceId: 'device-2', startedAtClient: 31_000, endedAtClient: 91_000,
    }),
    session({
      sessionId: 'c', bookId: 'book-2', bookTitle: 'Book Two', mode: 'tts',
      startedAtClient: 46_000, endedAtClient: 76_000, completed: true,
      endProgressPercent: 99,
      completionConfirmedAtClient: 76_000,
    }),
  ];
  const summary = buildReadingStatistics(sessions);
  assert.equal(summary.totalMs, 90_000);
  assert.equal(summary.screenMs, 60_000);
  assert.equal(summary.ttsMs, 30_000);
  assert.equal(summary.books.find(({ bookId }) => bookId === 'book-1')?.totalMs, 60_000);
  assert.equal(summary.books.find(({ bookId }) => bookId === 'book-2')?.totalMs, 30_000);
  assert.equal(summary.completedBookCount, 1);
  assert.equal(summary.countedSessionCount, 3);
});

test('preserves completion and progress metadata from an overlap loser', () => {
  const summary = buildReadingStatistics([
    session({
      sessionId: 'completed-loser', bookId: 'completed-book', bookTitle: 'Completed',
      startedAtClient: 1_000, endedAtClient: 61_000, completed: true,
      endProgressPercent: 100,
      completionConfirmedAtClient: 61_000,
    }),
    session({
      sessionId: 'tts-winner', bookId: 'other-book', bookTitle: 'Other', mode: 'tts',
      deviceId: 'device-2', startedAtClient: 1_000, endedAtClient: 61_000,
    }),
  ]);
  const completed = summary.books.find(({ bookId }) => bookId === 'completed-book');
  assert.equal(summary.completedBookCount, 1);
  assert.equal(completed?.completed, true);
  assert.equal(completed?.endProgressPercent, 100);
  assert.equal(completed?.totalMs, 0);
});

test('normalizes trusted device clocks and isolates uncalibrated clock domains', () => {
  const corrected = buildReadingStatistics([
    session({
      sessionId: 'clock-a', deviceId: 'device-a', startedAtClient: 1_000,
      endedAtClient: 61_000, clockOffsetMs: 0,
    }),
    session({
      sessionId: 'clock-b', deviceId: 'device-b', startedAtClient: 601_000,
      endedAtClient: 661_000, clockOffsetMs: -600_000,
    }),
  ]);
  assert.equal(corrected.totalMs, 60_000);
  assert.equal(corrected.uncertainClockSessionCount, 0);

  const uncertain = buildReadingStatistics([
    session({
      sessionId: 'uncertain-a', deviceId: 'device-a', startedAtClient: 1_000,
      endedAtClient: 61_000, clockOffsetMs: null,
    }),
    session({
      sessionId: 'uncertain-b', deviceId: 'device-b', startedAtClient: 1_000,
      endedAtClient: 61_000, clockOffsetMs: null,
    }),
  ]);
  assert.equal(uncertain.totalMs, 120_000);
  assert.equal(uncertain.uncertainClockSessionCount, 2);
});

test('clock correction uses the first sample on a tie and ignores samples older than a day', () => {
  const start = Date.UTC(2026, 10, 20, 12);
  const day = 24 * 60 * 60_000;
  const target = session({
    sessionId: 'target', startedAtClient: start, endedAtClient: start + 40_000, clockOffsetMs: null,
  });
  const sample = (sessionId, measuredAt, offset) => ({
    ...session({
      sessionId, startedAtClient: start - 300_000, endedAtClient: start - 290_000, clockOffsetMs: offset,
    }),
    clockMeasuredAtClient: measuredAt,
  });
  const after = sample('after', start + 30_000, 11_000);
  const before = sample('before', start - 30_000, -5_000);
  const sameTime = sample('same-time', start + 30_000, 23_000);
  const measure = (samples) => {
    let correctedStart;
    const summary = buildReadingStatistics([...samples, target], {}, ({ session: source, startAt }) => {
      if (source.sessionId === target.sessionId) correctedStart = startAt;
    });
    return { correctedStart, uncertain: summary.uncertainClockSessionCount };
  };
  assert.deepEqual(measure([after, before, sameTime]), { correctedStart: start + 11_000, uncertain: 0 });
  assert.deepEqual(measure([before, after, sameTime]), { correctedStart: start - 5_000, uncertain: 0 });
  assert.deepEqual(measure([sample('edge', start - day, 17_000)]), { correctedStart: start + 17_000, uncertain: 0 });
  assert.equal(measure([sample('expired', start - day - 1, 17_000)]).correctedStart, start);
});

test('aggregates a large session history without quadratic overlap scans', () => {
  const records = Array.from({ length: 20_000 }, (_, index) => session({
    sessionId: `bulk-${String(index).padStart(5, '0')}`,
    deviceId: `device-${index % 4}`,
    startedAtClient: 1_000 + index * 1_000,
    endedAtClient: 61_000 + index * 1_000,
  }));
  const started = performance.now();
  const summary = buildReadingStatistics(records);
  assert.equal(summary.sourceSessionCount, records.length);
  assert.ok(performance.now() - started < 2_500);
});

test('groups sessions by their recorded local day, Monday week, and month', () => {
  const now = new Date(2026, 7, 9, 12, 0, 0).getTime();
  const today = getReadingStatisticsRangeBounds('today', now);
  const week = getReadingStatisticsRangeBounds('week', now);
  const month = getReadingStatisticsRangeBounds('month', now);
  assert.equal(today.startLocalDate, '2026-08-09');
  assert.equal(week.startLocalDate, '2026-08-03');
  assert.equal(month.startLocalDate, '2026-08-01');

  const record = session({
    sessionId: 'range',
    startedAtClient: now - 30_000,
    endedAtClient: now + 30_000,
  });
  assert.equal(buildReadingStatistics([record], today).totalMs, 60_000);
  const yesterday = new Date(2026, 7, 8, 12, 0, 0).getTime();
  assert.equal(buildReadingStatistics([session({
    sessionId: 'yesterday', startedAtClient: yesterday, endedAtClient: yesterday + 60_000,
    timezoneOffsetMinutes: new Date(yesterday).getTimezoneOffset(),
  })], today).totalMs, 0);
});

test('uses the corrected canonical day consistently for headline and detail totals', () => {
  const dayStart = Date.UTC(2026, 7, 9, 0, 0, 0);
  const previousDayWallClock = dayStart - 60_000;
  const records = [
    session({
      sessionId: 'cross-day-tts',
      deviceId: 'clock-behind',
      mode: 'tts',
      startedAtClient: previousDayWallClock,
      endedAtClient: previousDayWallClock + 60_000,
      clockOffsetMs: 120_000,
    }),
    session({
      sessionId: 'canonical-screen',
      deviceId: 'clock-correct',
      startedAtClient: dayStart + 60_000,
      endedAtClient: dayStart + 120_000,
      clockOffsetMs: 0,
    }),
  ];
  const bounds = {
    startAt: Number.NEGATIVE_INFINITY,
    endAt: Number.POSITIVE_INFINITY,
    startLocalDate: '2026-08-09',
    endLocalDate: '2026-08-09',
  };
  const all = buildReadingStatistics(records);
  const headlineTotal = all.days
    .filter(({ localDate }) => localDate === '2026-08-09')
    .reduce((total, day) => total + day.totalMs, 0);
  const detail = buildReadingStatistics(records, bounds);
  assert.equal(headlineTotal, 60_000);
  assert.equal(detail.totalMs, headlineTotal);
  assert.equal(detail.ttsMs, 60_000);
});

test('splits a corrected canonical slice at local midnight', () => {
  const midnight = Date.UTC(2026, 7, 10, 0, 0, 0);
  const record = session({
    sessionId: 'corrected-midnight',
    startedAtClient: midnight - 2 * 60_000,
    endedAtClient: midnight,
    clockOffsetMs: 60_000,
  });
  const all = buildReadingStatistics([record]);
  assert.deepEqual(all.days, [
    { localDate: '2026-08-10', totalMs: 60_000, screenMs: 60_000, ttsMs: 0 },
    { localDate: '2026-08-09', totalMs: 60_000, screenMs: 60_000, ttsMs: 0 },
  ]);
  const day = buildReadingStatistics([record], {
    startLocalDate: '2026-08-10',
    endLocalDate: '2026-08-10',
  });
  assert.equal(day.totalMs, 60_000);
  assert.deepEqual(day.books[0]?.readDates, ['2026-08-10']);
});

test('uses chronological progress snapshots instead of min and max percentages', () => {
  const summary = buildReadingStatistics([
    session({
      sessionId: 'early', startedAtClient: 1_000, endedAtClient: 61_000,
      startProgressPercent: 80, endProgressPercent: 90,
    }),
    session({
      sessionId: 'late', startedAtClient: 62_000, endedAtClient: 122_000,
      startProgressPercent: 20, endProgressPercent: 30,
    }),
  ]);
  assert.equal(summary.books[0].startProgressPercent, 80);
  assert.equal(summary.books[0].endProgressPercent, 30);
});

test('statistics and JSON require two active minutes per reading block', () => {
  const sessions = [
    session({ sessionId: 'idle', bookId: 'idle', startedAtClient: 1_000, endedAtClient: 91_000 }),
    session({ sessionId: 'just-short', bookId: 'short', startedAtClient: 91_000, endedAtClient: 210_999 }),
    session({ sessionId: 'screen-one', startedAtClient: 301_000, endedAtClient: 391_000 }),
    session({
      sessionId: 'screen-two', startedAtClient: 541_000, endedAtClient: 601_000,
    }),
    session({
      sessionId: 'tts', bookId: 'other', mode: 'tts', startedAtClient: 301_000, endedAtClient: 331_000,
    }),
  ];
  const countedMsBySession = new Map();
  const displayed = buildReadingStatistics(sessions, {}, ({ session, durationMs }) => {
    countedMsBySession.set(session.sessionId, durationMs);
  }, { minimumMs: MIN_READING_STATISTICS_BLOCK_MS });
  assert.equal(displayed.totalMs, 120_000);
  assert.deepEqual([...countedMsBySession], [['screen-one', 60_000], ['screen-two', 60_000]]);
  assert.deepEqual(buildReadingBookRounds(sessions, {}, new Set(), countedMsBySession)
    .map(({ bookId, totalMs }) => [bookId, totalMs]), [['book-1', 120_000]]);
  assert.equal(buildReadingStatistics(sessions).totalMs, 359_999);

  const local = prepareLocalReadingReport(sessions);
  const json = createReadingStatisticsJsonExport(local.days, local.books({}), 1_700_000_000_000);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.sessions, undefined);
  assert.equal(parsed.summary.completedBookCount, undefined);
  assert.equal(parsed.summary.totalMs, displayed.totalMs);
  assert.deepEqual(parsed.summary.books.map(({ bookId, totalMs }) => [bookId, totalMs]), [['book-1', 120_000]]);
  assert.equal(parsed.summary.screenMs, 120_000);
  assert.equal(parsed.summary.ttsMs, 0);
});

test('statistics and JSON replace covered dates, including empty days, and keep both uncovered sides', () => {
  const dates = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-23'];
  const local = prepareLocalReadingReport(dates.map((localDate, index) => {
    const startedAtClient = Date.parse(localDate + 'T10:00:00Z');
    return session({ sessionId: String(index), localDate, startedAtClient, endedAtClient: startedAtClient + 120_000 });
  }));
  const archiveRange = { firstDay: '2026-11-16', lastDay: '2026-11-22' };
  const calendar = { ...archiveRange, days: [{ localDate: dates[1], totalMs: 180_000, screenMs: 0, ttsMs: 180_000 }] };
  const archive = { ...archiveRange, books: [{
    bookId: 'book-1', bookTitle: 'Archived title', lastReadAt: Date.parse(dates[1] + 'T11:00:00Z'),
    screenMs: 0, ttsMs: 180_000,
  }] };
  const days = mergePublishedCalendarDays(local.days, calendar);
  const books = local.books({}, archive);
  const { summary } = JSON.parse(createReadingStatisticsJsonExport(days, books).text);
  assert.deepEqual(summary.days.map(({ localDate }) => localDate), [dates[3], dates[1], dates[0]]);
  assert.equal(summary.totalMs, 420_000);
  assert.deepEqual(summary.books.map(({ screenMs, ttsMs, totalMs }) => [screenMs, ttsMs, totalMs]),
    [[240_000, 180_000, 420_000]]);
  const selected = local.books({ startLocalDate: dates[1], endLocalDate: dates[2] }, archive);
  assert.deepEqual(selected, archive.books);
});

test('a newly received clock sample can move a closed session into the next reporting week', () => {
  const startedAtClient = Date.parse('2026-11-22T23:55:00Z');
  const closed = session({ sessionId: 'closed', startedAtClient, endedAtClient: startedAtClient + 240_000, clockOffsetMs: null });
  const laterStart = Date.parse('2026-11-23T00:05:00Z');
  const clock = session({
    sessionId: 'new-clock', startedAtClient: laterStart, endedAtClient: laterStart + 60_000,
    clockOffsetMs: 600_000, clockUncertaintyMs: 0, clockMeasuredAtClient: laterStart,
  });
  const range = { firstDay: '2026-11-16', lastDay: '2026-11-22' };
  const closedSummary = prepareLocalReadingReport([closed]);
  const corrected = prepareLocalReadingReport([closed, clock]);
  assert.deepEqual(closedSummary.days.map(({ localDate }) => localDate), ['2026-11-22']);
  assert.deepEqual(corrected.days.map(({ localDate }) => localDate), ['2026-11-23']);
  assert.equal(hasPublishedBoundaryClockRisk([closed], range), false);
  assert.equal(hasPublishedBoundaryClockRisk([closed, { ...clock, deviceId: 'other' }], range), false);
  assert.equal(hasPublishedBoundaryClockRisk([closed, clock], range), true);
  assert.equal(corrected.days[0].totalMs, 240_000);
});

test('a checkpoint that crosses corrected midnight does not assign its full progress to either day', () => {
  const startedAtClient = Date.UTC(2026, 10, 20, 23, 57);
  const record = session({
    sessionId: 'midnight-progress',
    startedAtClient,
    endedAtClient: startedAtClient + 240_000,
    clockOffsetMs: 60_000,
    startProgressPercent: 18,
    endProgressPercent: 20,
  });
  const blocks = [];
  buildReadingStatistics([record], {}, undefined, {
    minimumMs: MIN_READING_STATISTICS_BLOCK_MS,
    onBlock: (block) => blocks.push(block),
  });
  assert.deepEqual(blocks.map(({ localDate, progressSpanPercent, durationMs }) => (
    [localDate, progressSpanPercent, durationMs]
  )), [
    ['2026-11-20', null, 120_000],
    ['2026-11-21', null, 120_000],
  ]);
});

test('tracks only visible active reading and actual playing TTS', () => {
  const base = {
    isLoaded: true,
    suspended: false,
    visibilityState: 'visible',
    ttsTrackingPhase: 'inactive',
    hasFocus: true,
    lastActivityAt: 10_000,
    now: 20_000,
  };
  assert.equal(getReadingTrackingMode(base), 'screen');
  assert.equal(getReadingTrackingMode({ ...base, visibilityState: 'hidden' }), null);
  assert.equal(getReadingTrackingMode({ ...base, suspended: true }), null);
  assert.equal(getReadingTrackingMode({ ...base, hasFocus: false }), null);
  assert.equal(getReadingTrackingMode({ ...base, now: 100_001 }), null);
  assert.equal(getReadingTrackingMode({ ...base, lastActivityAt: 0 }), null);
  assert.equal(getReadingTrackingMode({ ...base, ttsTrackingPhase: 'paused' }), null);
  assert.equal(getReadingTrackingMode({ ...base, ttsTrackingPhase: 'active-gap' }), null);
  assert.equal(getReadingTrackingMode({
    ...base,
    ttsTrackingPhase: 'active-run',
    hasFocus: false,
  }), 'tts');
  assert.equal(getReadingTrackingEndAt({
    mode: 'screen', now: 200_000, lastActivityAt: 10_000,
  }), 100_000);
  assert.equal(getReadingTrackingEndAt({
    mode: 'tts', now: 200_000, lastActivityAt: 10_000,
  }), 200_000);
});

test('treats reader activity as focus evidence across an immediate iframe focus transfer', () => {
  assert.equal(getNextReadingInteractionFocus(false, 'activity'), true);
  assert.equal(getNextReadingInteractionFocus(true, 'activity'), true);
  assert.equal(getNextReadingInteractionFocus(true, 'window-blur', true), true);
  assert.equal(getNextReadingInteractionFocus(true, 'window-blur', false), false);
  assert.equal(getNextReadingInteractionFocus(false, 'window-blur'), false);
  assert.equal(getNextReadingInteractionFocus(true, 'hidden'), false);
});

test('preserves screen activity across ordinary progress renders and resets on TTS exit', () => {
  assert.equal(shouldResetReadingActivityForTtsTransition('inactive', 'inactive'), false);
  assert.equal(shouldResetReadingActivityForTtsTransition('active-run', 'inactive'), true);
  assert.equal(shouldResetReadingActivityForTtsTransition('active-gap', 'paused'), true);
  assert.equal(shouldResetReadingActivityForTtsTransition('paused', 'paused'), false);

  const activityAt = 120_000;
  const activityAfterProgressRender = shouldResetReadingActivityForTtsTransition(
    'inactive',
    'inactive',
  ) ? 0 : activityAt;
  assert.equal(getReadingTrackingMode({
    isLoaded: true,
    suspended: false,
    visibilityState: 'visible',
    ttsTrackingPhase: 'inactive',
    hasFocus: true,
    lastActivityAt: activityAfterProgressRender,
    now: 125_000,
  }), 'screen');
});

test('keeps logical TTS continuity while excluding silent utterance transitions', () => {
  let phase = getNextReadingTtsTrackingPhase('inactive', 'starting');
  assert.equal(phase, 'awaiting-first-start');
  phase = getNextReadingTtsTrackingPhase(phase, 'playing');
  assert.equal(phase, 'active-run');
  for (const [status, expected] of [
    ['starting', 'active-gap'],
    ['loading', 'active-gap'],
    ['playing', 'active-run'],
    ['starting', 'active-gap'],
    ['playing', 'active-run'],
  ]) {
    phase = getNextReadingTtsTrackingPhase(phase, status);
    assert.equal(phase, expected);
  }
  phase = getNextReadingTtsTrackingPhase(phase, 'paused');
  assert.equal(phase, 'paused');
  assert.equal(getNextReadingTtsTrackingPhase(phase, 'loading'), 'awaiting-first-start');
  assert.equal(getNextReadingTtsTrackingPhase('active-run', 'finished'), 'inactive');
});

test('deduplicates TTS by its real active wall-clock intervals', () => {
  const start = 10 * 60 * 60_000;
  const tts = session({
    sessionId: 'tts-intervals',
    mode: 'tts',
    startedAtClient: start,
    endedAtClient: start + 10 * 60_000,
    durationMs: 5 * 60_000,
    activeIntervals: [
      { startedAtClient: start, endedAtClient: start + 2.5 * 60_000 },
      { startedAtClient: start + 7.5 * 60_000, endedAtClient: start + 10 * 60_000 },
    ],
  });
  const overlappingScreen = session({
    sessionId: 'screen-overlap',
    deviceId: 'device-2',
    startedAtClient: start + 8 * 60_000,
    endedAtClient: start + 9 * 60_000,
  });
  assert.equal(isReadingSessionV1(tts), true);
  const summary = buildReadingStatistics([tts, overlappingScreen]);
  assert.equal(summary.totalMs, 5 * 60_000);
  assert.equal(summary.ttsMs, 5 * 60_000);
  assert.equal(summary.screenMs, 0);
  assert.equal(summary.sourceSessionCount, 2);
});

test('detaches activity listeners from replaced reader documents', () => {
  const calls = [];
  const target = (name) => ({
    addEventListener: (eventName) => calls.push(`add:${name}:${eventName}`),
    removeEventListener: (eventName) => calls.push(`remove:${name}:${eventName}`),
  });
  const view = target('view');
  const oldDocument = target('old');
  const nextDocument = target('next');
  const attached = new Map();
  const listener = () => undefined;
  const events = ['pointerdown', 'keydown'];

  reconcileReadingActivityTargets(attached, new Set([view, oldDocument]), events, listener);
  reconcileReadingActivityTargets(attached, new Set([view, nextDocument]), events, listener);
  assert.equal(attached.has(oldDocument), false);
  assert.equal(attached.has(nextDocument), true);
  assert.deepEqual(calls.filter((call) => call.startsWith('remove:old:')), [
    'remove:old:pointerdown',
    'remove:old:keydown',
  ]);

  detachReadingActivityTargets(attached, listener);
  assert.equal(attached.size, 0);
});

test('hydrates one authoritative page after an exact timestamp and document tuple', async () => {
  const record = session({ sessionId: 'remote-page', startedAtClient: 1_000, endedAtClient: 61_000 });
  const constraints = [];
  const sdk = {
    Timestamp,
    collection: () => ({ kind: 'collection' }),
    documentId: () => '__name__',
    orderBy: (...args) => ({ kind: 'orderBy', args }),
    startAfter: (...args) => ({ kind: 'startAfter', args }),
    limit: (value) => ({ kind: 'limit', value }),
    query: (_reference, ...next) => {
      constraints.push(...next);
      return { kind: 'query' };
    },
    getDocsFromServer: async () => ({
      size: 1,
      docs: [{
        id: record.sessionId,
        data: () => ({
          ...record,
          uploadedAtServer: new Timestamp(30, 321),
        }),
      }],
    }),
  };
  const page = await getRemoteReadingSessionsPageV1(
    {},
    'alice',
    {
      uploadedAtServerSeconds: 20,
      uploadedAtServerNanoseconds: 123,
      documentId: 'previous',
    },
    500,
    sdk,
  );
  const startConstraint = constraints.find(({ kind }) => kind === 'startAfter');
  assert.equal(startConstraint.args[0].seconds, 20);
  assert.equal(startConstraint.args[0].nanoseconds, 123);
  assert.equal(startConstraint.args[1], 'previous');
  assert.deepEqual(page.nextCursor, {
    uploadedAtServerSeconds: 30,
    uploadedAtServerNanoseconds: 321,
    documentId: 'remote-page',
  });
  assert.equal(page.fullHydrationCompleted, true);
});

test('normalizes server-accepted local dates and quarantines only malformed records', async () => {
  const normalized = session({
    sessionId: 'wrong-local-date',
    startedAtClient: 1_000,
    endedAtClient: 61_000,
  });
  const malformed = session({
    sessionId: 'malformed-duration',
    startedAtClient: 62_000,
    endedAtClient: 122_000,
  });
  const sdk = {
    Timestamp,
    collection: () => ({}),
    documentId: () => '__name__',
    orderBy: (...args) => ({ args }),
    startAfter: (...args) => ({ args }),
    limit: (value) => ({ value }),
    query: () => ({}),
    getDocsFromServer: async () => ({
      size: 2,
      docs: [
        {
          id: normalized.sessionId,
          data: () => ({
            ...normalized,
            localDate: '2026-12-31',
            uploadedAtServer: new Timestamp(40, 1),
          }),
        },
        {
          id: malformed.sessionId,
          data: () => ({
            ...malformed,
            durationMs: 59_999,
            uploadedAtServer: new Timestamp(40, 2),
          }),
        },
      ],
    }),
  };
  const page = await getRemoteReadingSessionsPageV1({}, 'alice', null, 500, sdk);
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].localDate, getReadingSessionLocalDate(1_000, 0));
  assert.deepEqual(page.quarantinedDocuments.map(({ documentId }) => documentId), [
    'malformed-duration',
  ]);
  assert.deepEqual(page.nextCursor, {
    uploadedAtServerSeconds: 40,
    uploadedAtServerNanoseconds: 2,
    documentId: 'malformed-duration',
  });
});

test('quarantines a malformed upload timestamp and continues with later valid sessions', async () => {
  const valid = session({
    sessionId: 'valid-after-bad-cursor',
    startedAtClient: 1_000,
    endedAtClient: 61_000,
  });
  const sdk = {
    Timestamp,
    collection: () => ({}),
    documentId: () => '__name__',
    orderBy: (...args) => ({ args }),
    startAfter: (...args) => ({ args }),
    limit: (value) => ({ value }),
    query: () => ({}),
    getDocsFromServer: async () => ({
      size: 2,
      docs: [
        {
          id: 'bad-upload-time',
          data: () => ({ ...valid, sessionId: 'bad-upload-time', uploadedAtServer: 'bad' }),
        },
        {
          id: valid.sessionId,
          data: () => ({
            ...valid,
            uploadedAtServer: new Timestamp(50, 7),
          }),
        },
      ],
    }),
  };
  const page = await getRemoteReadingSessionsPageV1({}, 'alice', null, 500, sdk);
  assert.deepEqual(page.sessions.map(({ sessionId }) => sessionId), [valid.sessionId]);
  assert.deepEqual(page.quarantinedDocuments.map(({ documentId }) => documentId), [
    'bad-upload-time',
  ]);
  assert.deepEqual(page.nextCursor, {
    uploadedAtServerSeconds: 50,
    uploadedAtServerNanoseconds: 7,
    documentId: valid.sessionId,
  });
  assert.equal(page.fullHydrationCompleted, true);
});

test('uses an in-memory document cursor past a full page ending in a malformed timestamp', async () => {
  const valid = session({
    sessionId: 'valid-after-full-bad-page',
    startedAtClient: 1_000,
    endedAtClient: 61_000,
  });
  const malformedDocument = {
    id: 'bad-upload-time',
    data: () => ({ ...valid, sessionId: 'bad-upload-time', uploadedAtServer: 'bad' }),
  };
  const validDocument = {
    id: valid.sessionId,
    data: () => ({ ...valid, uploadedAtServer: new Timestamp(60, 9) }),
  };
  let reads = 0;
  let readAttempts = 0;
  const documentsPerQuery = [];
  const startAfterArguments = [];
  const sdk = {
    Timestamp,
    collection: () => ({}),
    documentId: () => '__name__',
    orderBy: (...args) => ({ args }),
    startAfter: (...args) => {
      startAfterArguments.push(args);
      return { args };
    },
    limit: (value) => ({ value }),
    query: () => ({}),
    getDocsFromServer: async () => {
      reads += 1;
      return reads === 1
        ? { size: 1, docs: [malformedDocument] }
        : { size: 1, docs: [validDocument] };
    },
  };
  const page = await getRemoteReadingSessionsPageV1({}, 'alice', null, 1, sdk, {
    onReadAttempt: () => { readAttempts += 1; },
    onReadSuccess: (documents) => { documentsPerQuery.push(documents); },
  });
  assert.equal(reads, 2);
  assert.equal(readAttempts, 2);
  assert.deepEqual(documentsPerQuery, [1, 1]);
  assert.equal(page.remoteReadAttemptCount, 2);
  assert.equal(page.remoteReadCount, 2);
  assert.equal(startAfterArguments[0][0], malformedDocument);
  assert.deepEqual(page.sessions.map(({ sessionId }) => sessionId), [valid.sessionId]);
  assert.deepEqual(page.nextCursor, {
    uploadedAtServerSeconds: 60,
    uploadedAtServerNanoseconds: 9,
    documentId: valid.sessionId,
  });
  assert.equal(page.fullHydrationCompleted, false);

  reads = 0;
  const checkpoint = { uploadedAtServerSeconds: 59, uploadedAtServerNanoseconds: 7, documentId: 'previous' };
  const preflight = await getRemoteReadingSessionsPageV1({}, 'alice', checkpoint, 1, sdk, {}, { singleSnapshot: true });
  assert.equal(reads, 1);
  assert.equal(preflight.fullHydrationCompleted, false);
  assert.deepEqual(preflight.nextCursor, checkpoint);
  assert.equal(preflight.quarantinedDocuments[0].documentId, malformedDocument.id);

  const readTimestampShapedMap = async () => ({
    size: 1,
    docs: [{ id: valid.sessionId, data: () => ({ ...valid, uploadedAtServer: { seconds: 60, nanoseconds: 9 } }) }],
  });
  const mapPage = await getRemoteReadingSessionsPageV1({}, 'alice', checkpoint, 2, {
    ...sdk, getDocsFromServer: readTimestampShapedMap,
  }, {}, { singleSnapshot: true });
  assert.deepEqual(mapPage.sessions, []);
  assert.deepEqual(mapPage.nextCursor, checkpoint);
  assert.equal(mapPage.quarantinedDocuments[0].documentId, valid.sessionId);
});

test('a published timestamp floor is exclusive without inventing a Firestore document ID', async () => {
  const floor = { seconds: 100, nanoseconds: 357 };
  const startAfter = [];
  const sdk = {
    Timestamp,
    collection: () => ({}), documentId: () => '__name__', orderBy: () => ({}),
    startAfter: (...args) => { startAfter.push(args); return {}; },
    endAt: () => ({}), startAt: () => assert.fail('must use the publication floor'),
    limit: () => ({}), query: () => ({}),
    getDocsFromServer: async () => ({ size: 0, docs: [] }),
  };
  const options = { timestampRangeOnly: true, publishedThrough: floor };
  const initial = await getRemoteReadingSessionsPageV1({}, 'alice', null, 500, sdk, {}, options);
  assert.deepEqual(startAfter[0], [new Timestamp(100, 357)]);
  assert.equal(initial.nextCursor, null);
  assert.equal(initial.fullHydrationCompleted, true);
  const tail = { uploadedAtServerSeconds: 108, uploadedAtServerNanoseconds: 99, documentId: 'actual-tail' };
  await getRemoteReadingSessionsPageV1({}, 'alice', tail, 500, sdk, {}, options);
  assert.deepEqual(startAfter[1], [new Timestamp(108, 99), 'actual-tail']);
});

test('reports a successful first read when the malformed-cursor follow-up read fails', async () => {
  const valid = session({
    sessionId: 'bad-cursor-before-failure',
    startedAtClient: 1_000,
    endedAtClient: 61_000,
  });
  let reads = 0;
  let attempts = 0;
  let successes = 0;
  const malformedDocument = {
    id: valid.sessionId,
    data: () => ({ ...valid, uploadedAtServer: 'bad' }),
  };
  const sdk = {
    Timestamp,
    collection: () => ({}),
    documentId: () => '__name__',
    orderBy: (...args) => ({ args }),
    startAfter: (...args) => ({ args }),
    limit: (value) => ({ value }),
    query: () => ({}),
    getDocsFromServer: async () => {
      reads += 1;
      if (reads === 1) return { size: 1, docs: [malformedDocument] };
      throw new Error('second-read-failed');
    },
  };
  await assert.rejects(getRemoteReadingSessionsPageV1({}, 'alice', null, 1, sdk, {
    onReadAttempt: () => { attempts += 1; },
    onReadSuccess: () => { successes += 1; },
  }), /second-read-failed/);
  assert.equal(attempts, 2);
  assert.equal(successes, 1);
});

test('legacy cursor adoption requires an exact authoritative timestamp and document ID', async () => {
  const cursor = { documentId: 'legacy', uploadedAtServerSeconds: 60, uploadedAtServerNanoseconds: 931 };
  let uploadedAtServer = new Timestamp(60, 931);
  let id = cursor.documentId;
  let exists = true;
  let hasPendingWrites = false;
  const paths = [];
  const sdk = {
    Timestamp,
    doc: (_firestore, path) => path,
    getDocFromServer: async (path) => {
      paths.push(path);
      return { id, exists: () => exists, metadata: { hasPendingWrites }, data: () => ({ uploadedAtServer }) };
    },
  };
  const verify = () => verifyLegacyReadingStatisticsCursorV1({}, 'alice', cursor, {}, sdk);
  assert.equal(await verify(), true);
  assert.deepEqual(paths, ['artifacts/private-web-novel-viewer/users/alice/libraries/local/readingStatsV1/legacy']);
  uploadedAtServer = { seconds: 60, nanoseconds: 931 };
  assert.equal(await verify(), false);
  uploadedAtServer = new Timestamp(60, 930);
  assert.equal(await verify(), false);
  uploadedAtServer = new Timestamp(60, 931);
  id = 'other';
  assert.equal(await verify(), false);
  id = cursor.documentId;
  exists = false;
  assert.equal(await verify(), false);
  exists = true;
  hasPendingWrites = true;
  await assert.rejects(verify(), /서버 확인/);
  await assert.rejects(verifyLegacyReadingStatisticsCursorV1({}, 'alice', cursor, {}, {
    ...sdk, getDocFromServer: async () => { throw new Error('offline'); },
  }), /offline/);
});

test('weekly audit checks the count and last record through the received cursor', async () => {
  const reference = {};
  let receivedCount = 9_429;
  let last = { id: 'last-received', timestamp: new Timestamp(60, 931) };
  let markerReads = 0;
  const boundary = { seconds: 60, nanoseconds: 931, id: 'last-received' };
  const receivedRange = [reference, ['uploadedAtServer', 'asc'], ['__name__', 'asc'], boundary];
  const sdk = {
    Timestamp,
    collection: () => reference,
    documentId: () => '__name__',
    orderBy: (...args) => args,
    endAt: (stamp, id) => ({ seconds: stamp.seconds, nanoseconds: stamp.nanoseconds, id }),
    limitToLast: (value) => ({ limitToLast: value }),
    query: (...args) => args,
    getCountFromServer: async (target) => {
      assert.deepEqual(target, receivedRange);
      return { data: () => ({ count: receivedCount }) };
    },
    getDocsFromServer: async (target) => {
      markerReads++;
      assert.deepEqual(target, [receivedRange, { limitToLast: 1 }]);
      return { size: 1, docs: [{ id: last.id, data: () => ({ uploadedAtServer: last.timestamp }) }] };
    },
  };
  const expected = {
    remoteCount: receivedCount,
    cursor: { uploadedAtServerSeconds: 60, uploadedAtServerNanoseconds: 931, documentId: 'last-received' },
  };
  const reports = [];
  const verify = () => verifyRemoteReadingStatisticsAuditV1({}, 'alice', expected, { onReadSuccess: (documents) => reports.push(documents) }, sdk);

  assert.equal(await verify(), true);
  assert.deepEqual(reports, [1]);
  last.timestamp = new Timestamp(60, 930);
  assert.equal(await verify(), false, 'a changed timestamp invalidates the cursor');
  last = { id: 'earlier-id', timestamp: new Timestamp(60, 931) };
  assert.equal(await verify(), false, 'a different record cannot stand in for a missing cursor');
  last = { id: 'last-received', timestamp: { seconds: 60, nanoseconds: 931 } };
  assert.equal(await verify(), false, 'a timestamp-shaped map cannot certify the old cursor');
  receivedCount--;
  assert.equal(await verify(), false);
  assert.equal(markerReads, 4, 'a changed count skips the marker lookup');
});

test('a bounded weekly audit recognizes stable quarantine and rejects repair, deletion, or a move beyond the cursor', async () => {
  const earlier = session({ sessionId: 'earlier-corrupt', startedAtClient: 1_000, endedAtClient: 61_000 });
  const marker = session({ sessionId: 'quarantined-marker', startedAtClient: 1_000, endedAtClient: 61_000 });
  const timestamp = new Timestamp(60, 931);
  const damaged = { ...earlier, durationMs: -1, uploadedAtServer: timestamp };
  let earlierData = damaged;
  let markerData = { ...marker, durationMs: -1, uploadedAtServer: timestamp };
  let count = 20_000;
  const pointPaths = [];
  let collectionPath;
  const sdk = {
    Timestamp,
    collection: (_db, path) => { collectionPath = path; return {}; },
    doc: (_db, path) => path,
    documentId: () => '__name__',
    orderBy: (...args) => args,
    endAt: (...args) => args,
    limitToLast: (value) => value,
    query: (...args) => args,
    getCountFromServer: async () => ({ data: () => ({ count }) }),
    getDocsFromServer: async () => ({ size: 1, docs: [{ id: marker.sessionId, data: () => markerData }] }),
    getDocFromServer: async (path) => {
      pointPaths.push(path);
      return { exists: () => earlierData !== null, data: () => earlierData };
    },
  };
  const expected = {
    remoteCount: count,
    cursor: { uploadedAtServerSeconds: 60, uploadedAtServerNanoseconds: 931, documentId: marker.sessionId },
    quarantinedDocumentIds: [earlier.sessionId, marker.sessionId],
  };
  const observations = [];
  const verify = () => verifyRemoteReadingStatisticsAuditV1({}, 'alice', expected, { onReadSuccess: (size) => observations.push(size) }, sdk);
  assert.equal(await verify(), true);
  assert.deepEqual(observations, [1, 1], 'only the cursor and non-cursor quarantine document are returned');
  assert.deepEqual(pointPaths, [`${collectionPath}/${earlier.sessionId}`]);

  earlierData = { ...earlier, uploadedAtServer: timestamp };
  assert.equal(await verify(), false, 'a repair may preserve both count and cursor');
  earlierData = null;
  assert.equal(await verify(), false, 'deletion remains detectable even if another document compensates for the count');
  earlierData = { ...damaged, uploadedAtServer: new Timestamp(60, 932) };
  assert.equal(await verify(), false);
  earlierData = { ...damaged, uploadedAtServer: { seconds: 60, nanoseconds: 930 } };
  assert.equal(await verify(), false, 'a timestamp-shaped map is outside the Firestore timestamp range');
  earlierData = damaged;
  markerData = { ...marker, uploadedAtServer: timestamp };
  assert.equal(await verify(), false, 'a repaired quarantine marker is also detected');
  count -= 1;
  const pointCount = pointPaths.length;
  assert.equal(await verify(), false);
  assert.equal(pointPaths.length, pointCount, 'a count mismatch skips point reads');
});

test('accepts only a low-uncertainty server clock sample', async () => {
  const sdk = {
    doc: () => ({ kind: 'doc' }),
    getDocFromServer: async () => ({
      exists: () => true,
      data: () => ({ uploadedAtServer: { toMillis: () => 10_600 } }),
    }),
  };
  assert.deepEqual(
    await readReadingStatisticsClockSampleV1({}, 'alice', 'session', 10_000, 11_000, sdk),
    { offsetMs: 100, uncertaintyMs: 500, measuredAtClient: 10_500 },
  );
  assert.equal(
    await readReadingStatisticsClockSampleV1({}, 'alice', 'session', 0, 11_000, sdk),
    null,
  );
});

test('shares one in-flight clock sample request per device and retries after settlement', async () => {
  const inFlight = new Map();
  let resolveFirst;
  let reads = 0;
  const firstRead = () => {
    reads += 1;
    return new Promise((resolve) => {
      resolveFirst = resolve;
    });
  };
  const first = readReadingStatisticsClockSampleSingleFlight(
    inFlight,
    'device-1',
    firstRead,
  );
  const shared = readReadingStatisticsClockSampleSingleFlight(
    inFlight,
    'device-1',
    firstRead,
  );
  assert.equal(first, shared);
  assert.equal(reads, 0);
  await Promise.resolve();
  assert.equal(reads, 1);
  resolveFirst({ offsetMs: 10, uncertaintyMs: 2, measuredAtClient: 100 });
  assert.deepEqual(await first, {
    offsetMs: 10,
    uncertaintyMs: 2,
    measuredAtClient: 100,
  });
  assert.equal(inFlight.size, 0);

  await readReadingStatisticsClockSampleSingleFlight(
    inFlight,
    'device-1',
    async () => {
      reads += 1;
      return null;
    },
  );
  assert.equal(reads, 2);
});
