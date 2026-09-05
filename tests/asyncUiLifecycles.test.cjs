/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS matches the TS hooks module boundary and shares ownerRuntime singleton identity. */
// Behavioral regressions for async auth and remote prompt lifetimes.
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { parseHTML } = require('linkedom');
const { createRoot } = require('react-dom/client');
require('fake-indexeddb/auto');

function storage() {
  const values = new Map();
  return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null,
    getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)),
    removeItem: k => values.delete(k), clear: () => values.clear() };
}
async function withDom(run) {
  const keys = ['window', 'document', 'CustomEvent', 'BroadcastChannel', 'IS_REACT_ACT_ENVIRONMENT', 'localStorage'];
  const previous = Object.fromEntries(keys.map(k => [k, globalThis[k]]));
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, CustomEvent: window.CustomEvent,
    BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true, localStorage: storage() });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  const root = createRoot(document.getElementById('app'));
  try { await run(root); }
  finally { await React.act(async () => root.unmount()); Object.assign(globalThis, previous); }
}
const noop = () => {};
const yes = () => true;
const no = () => false;
const asyncYes = async () => true;

test('remote prompt is rescheduled when a relocate cancels the pending display timer', async () => {
  const { useRemoteProgressPrompt } = require('../src/hooks/reader/useRemoteProgressPrompt.ts');
  await withDom(async root => {
    const originalSet = window.setTimeout, originalClear = window.clearTimeout;
    const timers = new Map(); let sequence = 0, state;
    window.setTimeout = (fn, ms, ...args) => ms === 0
      ? (timers.set(--sequence, () => fn(...args)), sequence)
      : originalSet(fn, ms, ...args);
    window.clearTimeout = id => id < 0 ? timers.delete(id) : originalClear(id);
    const common = {
      isLoaded: true,
      remoteProgress: { operation: 'set', bookId: 'review', cfi: 'remote', anchorCfi: 'remote', progressPercent: 80, lastRead: 200, syncRevision: 2 },
      localRevision: 1, lastSaveTimeRef: { current: 100 },
      waitForNavigationReady: asyncYes, goToStable: asyncYes, goToFractionStable: asyncYes,
      getBookmarks: () => [], adoptResolvedBookmarks: x => x, stageAutoBookmark: () => [], commitBookmarks: x => x,
      prepareRemoteJump: () => 1, prepareRemoteRollback: yes, cancelRemoteJump: noop, finishRemoteJump: noop,
      beginRemoteNavigationAttempt: () => ({ id: 1, interactionGeneration: 0, signal: new AbortController().signal }),
      isRemoteNavigationAttemptCurrent: yes, finishRemoteNavigationAttempt: noop,
      isQuietResumeEligible: no, isProgressConflictAutoResolveEligible: yes,
      adoptRemoteProgressBeforeNavigation: async () => ({ status: 'cancelled' }),
      completeRemoteJump: asyncYes, completeRemoteReset: asyncYes, hasLocalProgress: true,
    };
    function Harness(props) { state = useRemoteProgressPrompt({ ...common, ...props }); return null; }
    try {
      await React.act(async () => root.render(React.createElement(Harness, { currentCfi: 'local-a', currentAnchorCfi: 'local-a', totalProgress: 20 })));
      const scheduled = timers.size;
      await React.act(async () => root.render(React.createElement(Harness, { currentCfi: 'local-b', currentAnchorCfi: 'local-b', totalProgress: 21 })));
      const remaining = timers.size;
      await React.act(async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } });
      assert.equal(scheduled, 1);
      assert.equal(remaining, 1);
      assert.equal(state.syncConflict.cfi, 'remote');
    } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
  });
});

test('same-account relogin reloads the preserved Drive tab session', async () => {
  const { useNetworkLibrarySync } = require('../src/hooks/useNetworkLibrarySync.ts');
  await withDom(async root => {
    let loads = 0, view = 'loading';
    const common = { googleToken: 'fixture-token', driveSessionId: 'fixture-drive-session',
      setIsOfflineMode: noop, setView: value => { view = value; },
      loadLibraryFromDrive: async () => { loads++; return true; } };
    function Harness(props) { useNetworkLibrarySync({ ...common, ...props }); return null; }
    await React.act(async () => root.render(React.createElement(Harness, { user: { uid: 'A' }, isAuthenticatedLibraryReady: true })));
    assert.equal(loads, 1); assert.equal(view, 'shelf');
    await React.act(async () => root.render(React.createElement(Harness, { user: null, isAuthenticatedLibraryReady: false })));
    view = 'loading'; // useAuthBootstrap's shouldHoldShelfForDrive() branch.
    await React.act(async () => root.render(React.createElement(Harness, { user: { uid: 'A' }, isAuthenticatedLibraryReady: true })));
    assert.equal(loads, 2); assert.equal(view, 'shelf');
    await React.act(async () => root.render(React.createElement(Harness, { user: { uid: 'B' }, isAuthenticatedLibraryReady: true })));
    assert.equal(loads, 3); assert.equal(view, 'shelf');
    await React.act(async () => root.render(React.createElement(Harness, { user: { uid: 'B' }, isAuthenticatedLibraryReady: true })));
    assert.equal(loads, 3); // A normal rerender keeps the restored library.
  });
});


test('cancelled auth load cannot complete the next account shelf or suppress its retry', async () => {
  const { useNetworkLibrarySync } = require('../src/hooks/useNetworkLibrarySync.ts');
  await withDom(async root => {
    const pending = [];
    let view = 'loading', offline = false;
    const common = { googleToken: 'token', driveSessionId: 'same-session',
      setIsOfflineMode: value => { offline = value; }, setView: value => { view = value; },
      loadLibraryFromDrive: () => new Promise(resolve => pending.push(resolve)) };
    function Harness(props) { useNetworkLibrarySync({ ...common, ...props }); return null; }
    const render = async user => React.act(async () => root.render(React.createElement(Harness, {
      user, isAuthenticatedLibraryReady: Boolean(user),
    })));
    await render({ uid: 'A' });
    await render({ uid: 'B' });
    assert.equal(pending.length, 2);
    await React.act(async () => pending[0](false));
    assert.equal(view, 'loading'); assert.equal(offline, false);
    await render({ uid: 'A' });
    assert.equal(pending.length, 3);
    await React.act(async () => pending[1](true));
    assert.equal(view, 'loading');
    await React.act(async () => pending[2](true));
    assert.equal(view, 'shelf');
  });
});

test('cancelled pre-load microtask and rejected load both allow a fresh restore', async () => {
  const { useNetworkLibrarySync } = require('../src/hooks/useNetworkLibrarySync.ts');
  await withDom(async root => {
    const original = window.queueMicrotask;
    const queued = [];
    let loads = 0, view = 'loading';
    window.queueMicrotask = fn => queued.push(fn);
    const common = { googleToken: 'token', driveSessionId: 'session',
      setIsOfflineMode: noop, setView: value => { view = value; },
      loadLibraryFromDrive: async () => { loads++; if (loads === 1) throw new Error('offline'); return true; } };
    function Harness(props) { useNetworkLibrarySync({ ...common, ...props }); return null; }
    const render = async ready => React.act(async () => root.render(React.createElement(Harness, {
      user: { uid: 'A' }, isAuthenticatedLibraryReady: ready,
    })));
    try {
      await render(true); await render(false); await render(true);
      await React.act(async () => queued.splice(0).forEach(fn => fn()));
      assert.equal(loads, 1); assert.equal(view, 'shelf');
      await render(false); await render(true);
      await React.act(async () => queued.splice(0).forEach(fn => fn()));
      assert.equal(loads, 2); assert.equal(view, 'shelf');
    } finally { window.queueMicrotask = original; }
  });
});

test('batched logout and same-account login reloads when only the owner generation changed', async () => {
  const { useNetworkLibrarySync } = require('../src/hooks/useNetworkLibrarySync.ts');
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { makeOwnerKey, makeFirebaseOwnerKey, makeGuestOwnerKey } = require('../src/lib/ownerIdentity.ts');
  await withDom(async root => {
    let loads = 0;
    const user = { uid: 'batched-A' };
    const authOwner = makeOwnerKey(makeFirebaseOwnerKey(user.uid), 'library:local');
    const common = { user, googleToken: 'token', driveSessionId: 'session', isAuthenticatedLibraryReady: true,
      setIsOfflineMode: noop, setView: noop, loadLibraryFromDrive: async () => { loads++; return true; } };
    function Harness() { useNetworkLibrarySync(common); return null; }
    try {
      ownerRuntime.activate(authOwner);
      await React.act(async () => root.render(React.createElement(Harness)));
      ownerRuntime.activate(makeOwnerKey(makeGuestOwnerKey('batched-guest'), 'library:local'));
      ownerRuntime.activate(authOwner);
      await React.act(async () => root.render(React.createElement(Harness)));
      assert.equal(loads, 2);
    } finally { ownerRuntime.clear(); }
  });
});
