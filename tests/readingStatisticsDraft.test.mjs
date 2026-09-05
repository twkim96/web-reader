import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import {
  getReadingStatisticsDraftKey,
  holdReadingStatisticsDraftWriter,
  recoverReadingStatisticsDraft,
} from '../src/lib/readingStatisticsDraft.ts';
import { useReadingSessionTracker } from '../src/hooks/reader/useReadingSessionTracker.ts';
import { getLocalReadingSessionsV11, saveLocalReadingSessionV11 } from '../src/lib/localReadingStatistics.ts';
import { closeLocalDB } from '../src/lib/localDB.ts';
import { makeGuestOwnerKey, makeOwnerKey } from '../src/lib/ownerIdentity.ts';

// Model browser lock ownership, including the synchronous reservation made by
// a queued request before its callback runs in another execution context.
const makeLocks = () => {
  const held = new Map();
  return {
    request(name, options, callback) {
      if (typeof options === 'function') [callback, options] = [options, {}];
      if (held.has(name)) {
        if (options.ifAvailable) return Promise.resolve().then(() => callback(null));
        return held.get(name).then(() => this.request(name, options, callback));
      }
      let release;
      held.set(name, new Promise((resolve) => { release = resolve; }));
      return Promise.resolve().then(() => callback({ name })).finally(() => {
        held.delete(name);
        release();
      });
    },
  };
};

test('skips a live writer, then recovers its orphan checkpoint after context death', async () => {
  const locks = makeLocks();
  const releaseWriter = holdReadingStatisticsDraftWriter('writer-A', locks);
  let draft = { writerId: 'writer-A', state: 'active', lastHeartbeatAt: 5_000 };
  let recovered = 0;
  const recover = async () => { recovered++; draft = null; };
  await recoverReadingStatisticsDraft('draft-A', () => draft, recover, locks);
  assert.equal(recovered, 0);
  assert.ok(draft);
  releaseWriter(); // Browser automatically does this when a context crashes.
  await new Promise(setImmediate);
  await recoverReadingStatisticsDraft('draft-A', () => draft, recover, locks);
  assert.equal(recovered, 1);
  assert.equal(draft, null);
});

test('holds recovery ownership until persistence finishes and competing recoverers skip', async () => {
  const locks = makeLocks();
  let draft = { writerId: 'crashed-writer', state: 'active' };
  let commits = 0;
  let finish;
  const persistence = new Promise((resolve) => { finish = resolve; });
  const recover = async () => { commits++; await persistence; draft = null; };
  const first = recoverReadingStatisticsDraft('shared-draft', () => draft, recover, locks);
  await new Promise(setImmediate);
  await recoverReadingStatisticsDraft('shared-draft', () => draft, recover, locks);
  assert.equal(commits, 1);
  finish();
  await first;
  await recoverReadingStatisticsDraft('shared-draft', () => draft, recover, locks);
  assert.equal(commits, 1);
});

test('rereads a final close written while the browser grants the writer lock', async () => {
  const locks = makeLocks();
  let draft = { writerId: 'closing-writer', state: 'active', lastHeartbeatAt: 5_000 };
  let firstRead = true;
  let recovered;
  await recoverReadingStatisticsDraft('closing-draft', () => {
    const current = draft;
    if (firstRead) {
      firstRead = false;
      queueMicrotask(() => { draft = { ...draft, state: 'closed-pending', closedAtClient: 60_000 }; });
    }
    return current;
  }, async (current) => { recovered = current; }, locks);
  assert.equal(recovered.state, 'closed-pending');
  assert.equal(recovered.closedAtClient, 60_000);
});

test('retains active journals without provable ownership and still recovers closed journals', async () => {
  let recovered = 0;
  for (const locks of [undefined, makeLocks()]) {
    await recoverReadingStatisticsDraft('legacy', () => ({ state: 'active' }), async () => { recovered++; }, locks);
    assert.equal(recovered, 0);
  }
  await recoverReadingStatisticsDraft('no-locks', () => ({ state: 'active', writerId: 'other' }), async () => { recovered++; });
  assert.equal(recovered, 0);
  await recoverReadingStatisticsDraft('closed', () => ({ state: 'closed-pending' }), async () => { recovered++; });
  assert.equal(recovered, 1);
});

test('mounted tracker preserves another context active draft and recovers only a crashed writer', async () => {
  const keys = ['window', 'document', 'CustomEvent', 'BroadcastChannel', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage'];
  const previous = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const locks = makeLocks();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks });
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  const values = new Map();
  Object.assign(globalThis, {
    window, document: window.document, CustomEvent: window.CustomEvent,
    BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: {
      get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const ownerKey = makeOwnerKey(makeGuestOwnerKey('draft-regression'), 'library:local');
  const deviceId = 'same-device';
  const base = {
    schemaVersion: 1, state: 'active', ownerKey, deviceId,
    bookId: 'book-A', bookTitle: 'A', mode: 'screen',
    startedAtClient: 1_000, startedAtMonotonic: 0, lastHeartbeatAt: 6_000,
    startProgressPercent: 1, endProgressPercent: 2, timezoneOffsetMinutes: 0,
  };
  const active = { ...base, sessionId: 'live-session', writerId: 'live-window-A' };
  const activeKey = getReadingStatisticsDraftKey(ownerKey, deviceId, active.bookId, active.sessionId);
  const crash = { ...base, sessionId: 'crash-session', writerId: 'dead-window-C' };
  const crashKey = getReadingStatisticsDraftKey(ownerKey, deviceId, crash.bookId, crash.sessionId);
  localStorage.setItem(activeKey, JSON.stringify(active));
  localStorage.setItem(crashKey, JSON.stringify(crash));
  const releaseWriter = holdReadingStatisticsDraftWriter(active.writerId, locks);
  const root = createRoot(document.getElementById('app'));
  function Harness() {
    useReadingSessionTracker({ ownerKey, deviceId, book: { id: 'book-B', name: 'B' },
      isLoaded: false, suspended: false, ttsStatus: 'idle', progressPercent: 0,
      viewRef: { current: null } });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Harness, { key: 'recoverer-one' }),
      React.createElement(Harness, { key: 'recoverer-two' }))));
    let rows;
    for (let index = 0; index < 50; index++) {
      rows = await getLocalReadingSessionsV11(ownerKey);
      if (rows.length) break;
      await new Promise(setImmediate);
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, crash.sessionId);
    assert.equal(rows[0].durationMs, 5_000);
    assert.ok(localStorage.getItem(activeKey));
    await saveLocalReadingSessionV11(ownerKey, {
      schemaVersion: 1, sessionId: active.sessionId, deviceId,
      bookId: active.bookId, bookTitle: active.bookTitle, mode: 'screen',
      startedAtClient: 1_000, endedAtClient: 61_000, durationMs: 60_000,
      startProgressPercent: 1, endProgressPercent: 8,
      timezoneOffsetMinutes: 0, localDate: '1970-01-01', completed: false,
    });
    assert.equal((await getLocalReadingSessionsV11(ownerKey)).find((row) => row.sessionId === active.sessionId).durationMs, 60_000);
  } finally {
    await act(async () => root.unmount());
    releaseWriter();
    await closeLocalDB();
    if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks);
    else delete navigator.locks;
    Object.assign(globalThis, previous);
  }
});
