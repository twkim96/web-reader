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
  const crossing = session('crossing', midnight - 60_000, midnight + 60_000, {
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
      near('eight', 0), near('eight-one', 60_000), near('eight-four', 240_000),
      near('after-gap', 601_000), near('exactly-five', 961_000),
      near('listen', 1_021_000, { mode: 'tts' }), near('resume-screen', 1_081_000),
      near('other-book', 1_141_000, { bookId: 'other', bookTitle: '다른 책' }),
      near('after-other', 1_201_000),
    ]) await saveLocalReadingSessionV11(owner, record);
    await act(async () => { root.render(React.createElement(ReadingDashboard, { ownerKey: owner, onOpenStatistics() {}, onOpenAnnotations() {} })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    await act(async () => window.document.querySelector('button[aria-label="이전 달"]').dispatchEvent(new window.Event('click', { bubbles: true })));
    const day = [...window.document.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.startsWith(`${month.getMonth() + 1}월 15일,`));
    await act(async () => day.dispatchEvent(new window.Event('click', { bubbles: true })));
    const rows = [...window.document.querySelectorAll('section[aria-label="선택한 날짜의 독서 기록"] li')].map(row => row.textContent);
    assert.equal(rows.length, 8);
    assert.match(rows[0], /같은 책.*오전 8:20.*읽기1분$/);
    assert.match(rows[1], /다른 책.*오전 8:19.*읽기1분$/);
    assert.match(rows[2], /같은 책.*오전 8:18.*읽기1분$/);
    assert.match(rows[3], /같은 책.*오전 8:17.*듣기1분$/);
    assert.match(rows[4], /같은 책.*오전 8:10.*읽기2분$/);
    assert.match(rows[5], /같은 책.*오전 8:00.*읽기3분$/);
    assert.match(rows[6], /later.*오전 12:30/);
    assert.match(rows[7], /crossing.*오전 12:00/);
  } finally {
    await act(async () => root.unmount());
    await closeLocalDB();
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
});
