import test from 'node:test';
import assert from 'node:assert/strict';
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
  READING_SESSION_COMMIT_INTERVAL_MS,
  READING_SESSION_MAX_DURATION_MS,
  shouldResetReadingActivityForTtsTransition,
  sortReadingBookRoundsByRecent,
} from '../src/lib/readingStatistics.ts';

test('formats compact reader time as an unlabeled hour-minute clock', () => {
  assert.equal(formatReadingClock(0), '00:00');
  assert.equal(formatReadingClock(59_999), '00:00');
  assert.equal(formatReadingClock(60_000), '00:01');
  assert.equal(formatReadingClock(6_059_999), '01:40');
  assert.equal(formatReadingClock(360_000_000), '100:00');
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
  assert.equal(rounds[0].canComplete, false);
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
import {
  createReadingStatisticsJsonExport,
  createReadingStatisticsMarkdownExport,
} from '../src/lib/readingStatisticsExport.ts';
import {
  getRemoteReadingSessionsPageV1,
  readReadingStatisticsClockSampleV1,
  readReadingStatisticsClockSampleSingleFlight,
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

test('publishes new sessions every minute while accepting five-minute history', () => {
  assert.equal(READING_SESSION_COMMIT_INTERVAL_MS, 60_000);
  assert.equal(READING_SESSION_MAX_DURATION_MS, 300_000);
  assert.equal(getReadingSessionCommitBoundary(1_000, 0), 61_000);
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

test('exports recoverable JSON and overlap-safe Markdown totals', () => {
  const sessions = [
    session({ sessionId: 'json-a', startedAtClient: 1_000, endedAtClient: 61_000 }),
    session({
      sessionId: 'json-b', mode: 'tts', startedAtClient: 31_000, endedAtClient: 61_000,
    }),
  ];
  const json = createReadingStatisticsJsonExport(sessions, 1_700_000_000_000);
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.summary.totalMs, 60_000);
  assert.equal(parsed.summary.screenMs, 30_000);
  assert.equal(parsed.summary.ttsMs, 30_000);
  assert.equal(parsed.sessions.every(isReadingSessionV1), true);

  const markdown = createReadingStatisticsMarkdownExport(sessions, 1_700_000_000_000);
  assert.match(markdown.text, /총 독서 시간: 1분/);
  assert.match(markdown.text, /화면 독서: 1분 미만/);
  assert.match(markdown.text, /TTS 듣기: 1분 미만/);
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
          uploadedAtServer: { seconds: 30, nanoseconds: 321, toMillis: () => 30_000 },
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
            uploadedAtServer: { seconds: 40, nanoseconds: 1 },
          }),
        },
        {
          id: malformed.sessionId,
          data: () => ({
            ...malformed,
            durationMs: 59_999,
            uploadedAtServer: { seconds: 40, nanoseconds: 2 },
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
            uploadedAtServer: { seconds: 50, nanoseconds: 7 },
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
    data: () => ({ ...valid, uploadedAtServer: { seconds: 60, nanoseconds: 9 } }),
  };
  let reads = 0;
  let readAttempts = 0;
  let successfulReads = 0;
  const startAfterArguments = [];
  const sdk = {
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
    onReadSuccess: () => { successfulReads += 1; },
  });
  assert.equal(reads, 2);
  assert.equal(readAttempts, 2);
  assert.equal(successfulReads, 2);
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
