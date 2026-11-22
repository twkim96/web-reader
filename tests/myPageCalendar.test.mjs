import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingStatistics, getReadingSessionLocalDate } from '../src/lib/readingStatistics.ts';
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { ReadingDashboard } from '../src/components/mypage/ReadingDashboard.tsx';
import { saveLocalReadingSessionV11 } from '../src/lib/localReadingStatistics.ts';
import { closeLocalDB } from '../src/lib/localDB.ts';
import { setImmediate as settle } from 'node:timers/promises';

const session = (id, start, end, overrides = {}) => ({
  schemaVersion: 1, sessionId: id, bookId: id, bookTitle: id, deviceId: 'device', mode: 'screen',
  startedAtClient: start, endedAtClient: end, durationMs: end - start,
  startProgressPercent: 0, endProgressPercent: 1, timezoneOffsetMinutes: 0,
  localDate: getReadingSessionLocalDate(start, 0), completed: false,
  ...overrides,
});

const collect = (sessions, bounds = {}) => {
  const details = new Map();
  const summary = buildReadingStatistics(sessions, bounds, ({ session, localDate, durationMs }) => {
    const rows = details.get(localDate) ?? new Map();
    rows.set(session.sessionId, (rows.get(session.sessionId) ?? 0) + durationMs);
    details.set(localDate, rows);
  });
  return { summary, details };
};

test('calendar details use the same deduplicated screen and TTS time as the day total', () => {
  const start = Date.UTC(2026, 10, 20, 12);
  const { summary, details } = collect([
    session('screen', start, start + 60_000),
    session('tts', start, start + 60_000, { mode: 'tts' }),
  ]);
  assert.equal(summary.days[0].totalMs, 60_000);
  assert.deepEqual([...details.get('2026-11-20')], [['tts', 60_000]]);
});

test('corrected slices split at midnight and include the end date', () => {
  const start = Date.UTC(2026, 10, 20, 23, 58, 30);
  const records = [session('corrected', start, start + 60_000, {
    clockOffsetMs: 60_000, clockUncertaintyMs: 0, clockMeasuredAtClient: start,
  })];
  const { summary, details } = collect(records);
  assert.deepEqual([...details.get('2026-11-20')], [['corrected', 30_000]]);
  assert.deepEqual([...details.get('2026-11-21')], [['corrected', 30_000]]);
  for (const day of summary.days) {
    assert.equal([...details.get(day.localDate).values()].reduce((a, b) => a + b, 0), day.totalMs);
  }
  const endDay = collect(records, { startLocalDate: '2026-11-21', endLocalDate: '2026-11-21' });
  assert.equal(endDay.summary.totalMs, 30_000);
  assert.deepEqual([...endDay.details.get('2026-11-21')], [['corrected', 30_000]]);
});

test('day rows group nearby reading slices and exclude breaks in the recorded timezone', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  Object.assign(globalThis, { window, document: window.document, localStorage: storage, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent, BroadcastChannel: undefined });
  window.localStorage = storage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(window.document.querySelector('#root'));
  const owner = 'guest:calendar-test|library:local';
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const midnight = Date.UTC(month.getFullYear(), month.getMonth(), 15) - 9 * 60 * 60_000;
  const crossing = session('crossing', midnight - 60_000, midnight + 30_000, {
    timezoneOffsetMinutes: -540, localDate: getReadingSessionLocalDate(midnight - 60_000, -540),
  });
  const later = session('later', midnight - 2 * 60_000, midnight + 31 * 60_000, {
    mode: 'tts', durationMs: 120_000,
    activeIntervals: [
      { startedAtClient: midnight - 2 * 60_000, endedAtClient: midnight - 60_000 },
      { startedAtClient: midnight + 30 * 60_000, endedAtClient: midnight + 31 * 60_000 },
    ],
    timezoneOffsetMinutes: -540, localDate: getReadingSessionLocalDate(midnight - 2 * 60_000, -540),
  });
  try {
    await saveLocalReadingSessionV11(owner, crossing);
    await saveLocalReadingSessionV11(owner, later);
    const eightAM = midnight + 8 * 60 * 60_000;
    const near = (id, offset, options = {}) => session(id, eightAM + offset, eightAM + offset + 60_000, {
      bookId: 'same', bookTitle: '같은 책', timezoneOffsetMinutes: -540,
      localDate: getReadingSessionLocalDate(eightAM, -540), ...options,
    });
    for (const record of [
      near('eight', 0, { startProgressPercent: 18.2, endProgressPercent: 20 }),
      near('eight-one', 60_000, { startProgressPercent: 20, endProgressPercent: 21 }),
      near('eight-four', 240_000, { startProgressPercent: 21, endProgressPercent: 18.2 }),
      near('after-gap', 601_000), near('exactly-five', 961_000),
      near('listen', 1_021_000, { mode: 'tts' }), near('resume-screen', 1_081_000),
      near('other-book', 1_141_000, { bookId: 'other', bookTitle: '다른 책' }),
      near('after-other', 1_201_000),
      near('merged-short-a', 1_800_000),
      near('merged-short-b', 1_920_000),
      near('hidden-short-a', 2_400_000, { bookId: 'short-a', bookTitle: '짧은 기록 A', endedAtClient: eightAM + 2_430_000, durationMs: 30_000 }),
      near('hidden-short-b', 2_430_000, { bookId: 'short-b', bookTitle: '짧은 기록 B', endedAtClient: eightAM + 2_460_000, durationMs: 30_000 }),
    ]) await saveLocalReadingSessionV11(owner, record);
    let refreshes = 0;
    await act(async () => { root.render(React.createElement(ReadingDashboard, {
      ownerKey: owner, onRefresh() { refreshes++; }, onOpenStatistics() {}, onOpenAnnotations() {},
    })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(refreshes, 1, 'opening the calendar requests a refresh');
    await act(async () => window.document.querySelector('button[aria-label="이전 달"]').dispatchEvent(new window.Event('click', { bubbles: true })));
    const day = [...window.document.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.startsWith(`${month.getMonth() + 1}월 15일,`));
    await act(async () => day.dispatchEvent(new window.Event('click', { bubbles: true })));
    const rows = [...window.document.querySelectorAll('section[aria-label="선택한 날짜의 독서 기록"] li')].map(row => row.textContent);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /같은 책.*오전 8:30.*읽기1\.00%p \| 2분$/);
    assert.match(rows[1], /같은 책.*오전 8:10.*읽기1\.00%p \| 2분$/);
    assert.match(rows[2], /같은 책.*오전 8:00.*읽기2\.80%p \| 3분$/);
    assert.match(day.getAttribute('aria-label'), /7분$/);
    assert.match(window.document.querySelector('section[aria-label="선택한 날짜의 독서 기록"]').textContent, /15일7분/);
    const totals = [...window.document.querySelectorAll('[aria-label="독서 시간 요약"] dd')].map(node => node.textContent);
    assert.deepEqual(totals, ['0분', '0분', '7분']);
    assert.equal(refreshes, 1, 'browsing calendar dates does not request another sync');
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
});

test('dashboard updates day and month totals at midnight and on resume without re-reading sessions', async (t) => {
  const beforeMidnight = new Date(2026, 10, 30, 23, 59, 59);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: beforeMidnight.getTime() });
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  Object.assign(globalThis, { window, document: window.document, localStorage: storage, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, Event: window.Event, CustomEvent: window.CustomEvent, BroadcastChannel: undefined });
  window.localStorage = storage;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const ownerKey = 'guest:calendar-rollover|library:local';
  const end = beforeMidnight.getTime() - 1;
  const start = end - 120_000;
  await saveLocalReadingSessionV11(ownerKey, session('prior-day', start, end, {
    timezoneOffsetMinutes: beforeMidnight.getTimezoneOffset(),
    localDate: getReadingSessionLocalDate(start, beforeMidnight.getTimezoneOffset()),
  }));
  const reads = t.mock.method(IDBIndex.prototype, 'getAll');
  const root = createRoot(window.document.querySelector('#root'));
  const totals = () => [...window.document.querySelectorAll('[aria-label="독서 시간 요약"] dd')].map((node) => node.textContent);
  try {
    await act(async () => root.render(React.createElement(ReadingDashboard, { ownerKey, onOpenStatistics() {}, onOpenAnnotations() {} })));
    for (let i = 0; i < 20 && totals()[0] !== '2분'; i++) await act(async () => settle());
    assert.deepEqual(totals(), ['2분', '2분', '2분']);
    await act(async () => t.mock.timers.tick(1000));
    assert.deepEqual(totals(), ['0분', '0분', '2분']);
    assert.match(window.document.querySelector('[aria-pressed="true"]').getAttribute('aria-label'), /^11월 30일/);

    t.mock.timers.setTime(beforeMidnight.getTime());
    await act(async () => window.dispatchEvent(new window.Event('focus')));
    assert.deepEqual(totals(), ['2분', '2분', '2분']);
    assert.equal(reads.mock.callCount(), 1);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
  }
});
