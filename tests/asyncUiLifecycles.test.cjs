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

test('cancelling a popup ignores its late account and accepts a new login independently', async () => {
  const paths = ['../src/lib/firebase.ts', 'firebase/auth', '../src/hooks/useGoogleLogin.ts']
    .map(path => require.resolve(path));
  const previous = paths.map(path => require.cache[path]);
  const auth = { currentUser: null };
  const popupAuth = {};
  const popups = [];
  const accepted = [];
  const errors = [];
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: {
    auth, getGooglePopupAuth: () => popupAuth, setGoogleRedirectCancelled: noop,
  } };
  require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: {
    signInWithPopup: (target) => {
      assert.equal(target, popupAuth);
      return new Promise(resolve => popups.push(resolve));
    },
    updateCurrentUser: async (target, user) => {
      assert.equal(target, auth);
      accepted.push(user.uid);
      auth.currentUser = user;
    },
  } };
  delete require.cache[paths[2]];
  try {
    const { useGoogleLogin } = require(paths[2]);
    await withDom(async root => {
      let login;
      function Harness() {
        login = useGoogleLogin(error => errors.push(error));
        return React.createElement('output', null, login.phase);
      }
      await React.act(async () => root.render(React.createElement(Harness)));
      const phase = () => document.querySelector('output').textContent;
      await React.act(async () => { login.start('popup'); login.start('popup'); });
      assert.equal(phase(), 'waiting');
      assert.equal(popups.length, 1);
      await React.act(async () => login.cancel());
      assert.equal(phase(), '');
      await React.act(async () => login.start('popup'));
      await React.act(async () => popups[0]({ user: { uid: 'abandoned' } }));
      assert.equal(phase(), 'waiting');
      assert.equal(auth.currentUser, null);
      await React.act(async () => popups[1]({ user: { uid: 'accepted' } }));
      assert.equal(phase(), 'finishing');
      assert.deepEqual(accepted, ['accepted']);
      await React.act(async () => login.finish());
      assert.equal(phase(), '');
      assert.deepEqual(errors, []);
    });
  } finally {
    paths.forEach((path, index) => {
      if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path];
    });
  }
});

test('new saves wake the worker, including after a failed logout restores the same owner', { timeout: 5_000 }, async (t) => {
  const firebasePath = require.resolve('../src/lib/firebase.ts');
  const authPath = require.resolve('firebase/auth');
  const workerPath = require.resolve('../src/hooks/useProgressSyncWorker.ts');
  const outbox = require('../src/lib/syncOutboxV5.ts');
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { ProgressSyncPumpController } = require('../src/lib/progressSyncPump.ts');
  const leaseTransportPath = require.resolve('../src/lib/writeLeaseTransport.ts');
  const leases = require(leaseTransportPath);
  const paths = [firebasePath, authPath, leaseTransportPath, workerPath];
  const previous = paths.map(path => require.cache[path]);
  let requested;
  let leasePreparations = 0;
  let workerSubscriptions = 0;
  const expectWake = () => new Promise(resolve => { requested = resolve; });
  t.mock.method(ProgressSyncPumpController.prototype, 'request', () => requested?.());
  const setExports = (path, exports) => {
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };
  setExports(firebasePath, { auth: {}, db: {} });
  setExports(authPath, { onIdTokenChanged: () => { workerSubscriptions++; return noop; } });
  setExports(leaseTransportPath, {
    ...leases, finiteWriteLeasesEnabled: yes,
    prepareWriteLease: async () => { leasePreparations++; }, requestReceiptMaintenance: asyncYes,
  });
  delete require.cache[workerPath];
  const owner = 'firebase:wake-regression|library:local';
  const user = { uid: 'wake-regression' };
  try {
    const { useProgressSyncWorker } = require(workerPath);
    const save = (bookId) => outbox.enqueueProgressEventV5(owner, {
      bookId, operation: 'progress.set', position: { cfi: 'new', anchorCfi: null, progressPercent: 25 },
      deviceId: 'wake-device', sessionId: 'wake-session', eventId: bookId,
    });
    await withDom(async (root) => {
      await save('paused-book');
      const now = Date.now();
      const lease = await outbox.acquireSyncLeaseV5(owner, 'fixture', now, 5000);
      const event = await outbox.claimNextProgressEventV5(owner, 'fixture', lease.epoch, now + 1);
      await outbox.pauseProgressEventV5(owner, event.eventId, 'permission-denied', outbox.getExpectedClaimV5(event));

      ownerRuntime.activate(owner);
      function Harness() {
        useProgressSyncWorker(user, owner, 'wake-device');
        return null;
      }
      let wake = expectWake();
      const network = Object.getOwnPropertyDescriptor(navigator, 'onLine');
      try {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        await React.act(async () => root.render(React.createElement(Harness)));
        assert.equal(leasePreparations, 0, 'offline startup must not write a lease');
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
        window.dispatchEvent(new window.Event('online'));
      } finally {
        if (network) Object.defineProperty(navigator, 'onLine', network);
        else delete navigator.onLine;
      }
      await wake;
      assert.equal(leasePreparations, 1);
      // Startup may retry a paused write. Simulate the same permission failure.
      const retry = await outbox.claimNextProgressEventV5(owner, 'fixture', lease.epoch, Date.now() + 1);
      assert.equal(retry.eventId, 'paused-book');
      await outbox.pauseProgressEventV5(owner, retry.eventId, 'permission-denied', outbox.getExpectedClaimV5(retry));
      wake = expectWake();
      await save('new-book');
      await wake;
      const events = await outbox.getOutboxEventsV5(owner);
      assert.equal(events.find(event => event.eventId === 'paused-book').status, 'paused');
      assert.equal(events.find(event => event.eventId === 'new-book').status, 'pending');

      const { runLogoutFlow } = require('../src/lib/logoutFlow.ts');
      const originalOwner = ownerRuntime.capture();
      await React.act(async () => {
        assert.equal(await runLogoutFlow({
          prepareUi: () => ownerRuntime.clear(),
          signOut: async () => { throw new Error('fixture sign-out failed'); },
          commitLocalCleanup: () => assert.fail('logout did not complete'),
          recoverUi: () => ownerRuntime.activate(owner),
        }), false);
      });
      assert.equal(ownerRuntime.isCurrent(originalOwner), false);
      assert.equal(workerSubscriptions, 2, 'the same owner key must start a new worker after rollback');
      wake = expectWake();
      await save('saved-after-logout-failure');
      await wake;
    });
  } finally {
    ownerRuntime.clear();
    paths.forEach((path, i) => {
      if (previous[i]) require.cache[path] = previous[i];
      else delete require.cache[path];
    });
  }
});

test('keeping a remotely deleted bookmark updates its id before the reader can delete it again', async () => {
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { useSyncConflictResolution } = require('../src/hooks/useSyncConflictResolution.ts');
  const { useProgressActions } = require('../src/hooks/useProgressActions.ts');
  const outbox = require('../src/lib/syncOutboxV5.ts');
  const { saveProgressToLocalV5 } = require('../src/lib/localDBV5.ts');
  const ownerKey = 'firebase:keep-bookmark|library:local';
  const user = { uid: 'keep-bookmark' };
  const bookId = 'book';
  const bookmark = { id: 'old-mark', type: 'manual', name: 'mark', color: '#fff', cfi: 'mark', createdAt: 1 };
  const initial = { bookId, cfi: 'reader', progressPercent: 50, lastRead: 1, bookmarks: [bookmark] };
  await saveProgressToLocalV5(ownerKey, initial);
  await outbox.enqueueBookmarkEventV5(ownerKey, {
    bookId, bookmarkId: bookmark.id, operation: 'bookmark.upsert',
    payload: { bookmarkId: bookmark.id, cfi: bookmark.cfi, name: bookmark.name, color: bookmark.color,
      createdAtClient: 1, updatedAtClient: 2, progressPercent: null },
    localBookmarks: [bookmark],
    deviceId: 'device', sessionId: 'session', eventId: 'bookmark-event', occurredAtClient: 2,
  });
  const lease = await outbox.acquireSyncLeaseV5(ownerKey, 'tab', 10, 50);
  const claimed = await outbox.claimNextProgressEventV5(ownerKey, 'tab', lease.epoch, 11);
  await outbox.recordProgressConflictV5(ownerKey, claimed.eventId, {
    schemaVersion: 2, bookId, bookmarkId: bookmark.id, revision: 2, operation: 'delete',
    bookmark: null, deletedAtServer: {}, updatedAtServer: {}, occurredAtClient: 3,
    acceptedEventId: 'deleted-remotely', acceptedDeviceId: 'other',
  }, outbox.getExpectedClaimV5(claimed), 12);

  ownerRuntime.activate(ownerKey);
  try {
    await withDom(async root => {
      let state, actions, reader;
      function Harness() {
        const progressRef = React.useRef({ [bookId]: initial });
        const [progress, setProgress] = React.useState(progressRef.current);
        const deviceId = React.useRef('device');
        state = useSyncConflictResolution({
          user, ownerKey, activeBookId: bookId, progressRef, setProgress, setRemoteProgress: noop,
          flushReaderProgress: asyncYes,
        });
        actions = useProgressActions({ user, progressRef, setProgress, deviceId, activeBook: { id: bookId } });
        reader = progress[bookId];
        return null;
      }
      await React.act(async () => root.render(React.createElement(Harness)));
      for (let i = 0; i < 12 && !state.conflict; i++) {
        await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      }
      assert.equal(state.conflict?.conflictId, 'bookmark-event');
      await React.act(async () => assert.equal(await state.keepLocal(), true));
      const [restored] = reader.bookmarks;
      assert.notEqual(restored.id, bookmark.id);
      assert.equal(reader.cfi, initial.cfi);
      await React.act(async () => assert.equal(await actions.saveBookmarkMutation(bookId, {
        kind: 'delete', bookmarkId: restored.id,
      }), true));
      assert.deepEqual(reader.bookmarks, []);
      const writes = await outbox.getOutboxEventsV5(ownerKey);
      assert.ok(writes.some(event => event.operation === 'bookmark.delete' && event.target.bookmarkId === restored.id));
    });
  } finally { ownerRuntime.clear(); }
});

test('a failed library read preserves durable progress and a genuinely empty library can still open', async (t) => {
  const { useLibraryData } = require('../src/hooks/useLibraryData.ts');
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  const { V5_PROGRESS_STORE } = require('../src/lib/localDBSchema.ts');
  const { loadProgressFromLocalV5, saveProgressToLocalV5 } = require('../src/lib/localDBV5.ts');
  const ownerKey = 'firebase:local-read-failure|library:local';
  const bookId = 'local-read-failure-book';
  const originalGetAll = IDBIndex.prototype.getAll;
  let failRead = true;
  t.mock.method(IDBIndex.prototype, 'getAll', function (query, ...args) {
    if (failRead && query === ownerKey && this.objectStore.name === V5_PROGRESS_STORE) {
      throw new Error('fixture progress read failed');
    }
    return originalGetAll.call(this, query, ...args);
  });
  t.mock.method(console, 'error', noop);
  await saveProgressToLocalV5(ownerKey, { bookId, cfi: 'saved', progressPercent: 60, lastRead: 100 });

  try {
    await withDom(async root => {
      // The lower-level restore is used by the auth hook in production. This
      // fixture exercises real IndexedDB results without mounting Firebase.
      let library;
      function Harness() {
        library = useLibraryData({ clearToken: noop, setIsOfflineMode: noop, setView: noop, driveSessionId: null });
        return null;
      }
      ownerRuntime.activate(ownerKey);
      await React.act(async () => root.render(React.createElement(Harness)));
      await React.act(async () => assert.equal(await library.restoreLocalData(), 'failed'));
      assert.deepEqual(library.progress, {});
      assert.equal((await loadProgressFromLocalV5(ownerKey, bookId)).progressPercent, 60);
      failRead = false;
      await React.act(async () => assert.equal(await library.restoreLocalData(), 'empty'));
      assert.equal(library.progress[bookId].progressPercent, 60);
    });
  } finally {
    ownerRuntime.clear();
  }
});

for (const offline of [false, true]) test(
  `account reader waits for hydration and retries failed authentication restore (offline=${offline})`,
  async () => {
  const { readFileSync } = require('node:fs');
  const page = readFileSync(require.resolve('../src/app/page.tsx'), 'utf8');
  const predicate = page.match(/\{(view === 'reader'[^\n]+) && \(\s*<EpubReader/)?.[1];
  assert.ok(predicate, 'production reader render condition is available');
  const canRenderReader = new Function('view', 'activeBook', 'activeOwnerKey', 'isLibraryBootstrapReady',
    `return Boolean(${predicate});`);
  const paths = ['../src/lib/firebase.ts', 'firebase/auth', '../src/hooks/useAuthBootstrap.ts']
    .map(path => require.resolve(path));
  const previous = paths.map(path => require.cache[path]);
  const { ownerRuntime } = require('../src/lib/ownerRuntime.ts');
  let authCallback;
  require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { auth: { currentUser: null } } };
  require.cache[paths[1]] = { id: paths[1], filename: paths[1], loaded: true, exports: {
    onAuthStateChanged: (_auth, callback) => { authCallback = callback; return noop; },
  } };
  delete require.cache[paths[2]];
  try {
    const { useAuthBootstrap } = require('../src/hooks/useAuthBootstrap.ts');
    await withDom(async root => {
      const { useNetworkLibrarySync } = require('../src/hooks/useNetworkLibrarySync.ts');
      const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      const network = { onLine: !offline };
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: network });
      const originalSet = window.setTimeout, originalClear = window.clearTimeout;
      const timers = new Map();
      const opens = [];
      const guestRestores = [];
      let resolveOutgoingFlush;
      const flushOutgoingProgress = () => ownerRuntime.capture()?.ownerKey.startsWith('firebase:')
        ? new Promise(resolve => { resolveOutgoingFlush = resolve; }) : undefined;
      const book = { id: 'cold-start-book' };
      let resolveAccount;
      let resolveLogoutRestore;
      let accountAttempts = 0;
      let bootstrap;
      let driveLoads = 0;
      const loadLibraryFromDrive = async () => { driveLoads++; return true; };
      const accountHydration = new Promise(resolve => { resolveAccount = resolve; });
      window.setTimeout = (fn, ms, ...args) => ms === 3_000
        ? (timers.set(-1, () => fn(...args)), -1)
        : originalSet(fn, ms, ...args);
      window.clearTimeout = id => id === -1 ? timers.delete(id) : originalClear(id);
      function Reader({ ownerKey, initialPercent }) {
        const startup = React.useRef({ ownerKey, initialPercent });
        React.useEffect(() => { opens.push(startup.current); }, []);
        return null;
      }
      function Harness() {
        const [user, setUser] = React.useState(null);
        const [, setIsGuest] = React.useState(false);
        const [view, setView] = React.useState('loading');
        const [books, setBooks] = React.useState([]);
        const [progress, setProgress] = React.useState({});
        const [activeBook, setActiveBook] = React.useState(null);
        const isGuestRef = React.useRef(false);
        const triedAutoOpen = React.useRef(false);
        const resetLibraryState = React.useCallback(() => { setBooks([]); setProgress({}); }, []);
        const restoreLocalData = React.useCallback(async (options) => {
          const { ownerKey } = ownerRuntime.capture();
          if (ownerKey === 'firebase:empty-account|library:local') return 'empty';
          const account = ownerKey.startsWith('firebase:');
          if (account) {
            await accountHydration;
            if (++accountAttempts === 1 && !offline) return 'failed';
          }
          else {
            guestRestores.push(options?.guestHandoff);
            if (options?.guestHandoff?.confirmed) await new Promise(resolve => { resolveLogoutRestore = resolve; });
          }
          setBooks([book]);
          setProgress(account ? { [book.id]: { progressPercent: 60 } } : {});
          return 'restored';
        }, []);
        bootstrap = useAuthBootstrap({ isGuestRef, setUser, setIsGuest,
          setIsOfflineMode: noop, setView, restoreLocalData, resetLibraryState, shouldHoldShelfForDrive: offline ? yes : no,
          flushOutgoingProgress });
        const { isLibraryBootstrapReady, isAuthenticatedLibraryReady } = bootstrap;
        useNetworkLibrarySync({ user, isAuthenticatedLibraryReady, googleToken: offline ? 'token' : null,
          driveSessionId: offline ? 'session' : null, loadLibraryFromDrive, setView, setIsOfflineMode: noop });
        React.useEffect(() => {
          if (triedAutoOpen.current || view !== 'shelf' || !isLibraryBootstrapReady || !books.length) return;
          triedAutoOpen.current = true;
          setActiveBook(books[0]); setView('reader');
        }, [books, isLibraryBootstrapReady, view]);
        const activeOwnerKey = ownerRuntime.capture()?.ownerKey;
        return canRenderReader(view, activeBook, activeOwnerKey, isLibraryBootstrapReady)
          ? React.createElement(Reader, { key: `${activeOwnerKey}:${activeBook.id}`, ownerKey: activeOwnerKey,
            initialPercent: progress[activeBook.id]?.progressPercent }) : null;
      }
      try {
        ownerRuntime.clear();
        await React.act(async () => root.render(React.createElement(Harness)));
        await React.act(async () => { for (const fn of timers.values()) fn(); timers.clear(); });
        const guestOpens = offline ? 0 : 1;
        assert.equal(opens.length, guestOpens);
        if (!offline) assert.equal(opens[0].initialPercent, undefined);
        if (offline) assert.equal(localStorage.getItem('isGuest'), null);
        await React.act(async () => authCallback({ uid: 'cold-start-account' }));
        assert.equal(opens.length, guestOpens, 'account reader must wait for its pending hydration');
        await React.act(async () => resolveAccount());
        if (!offline) {
          assert.equal(bootstrap.libraryRestoreFailed, true);
          assert.equal(bootstrap.isLibraryBootstrapReady, false);
          assert.equal(bootstrap.isAuthenticatedLibraryReady, false);
          assert.equal(opens.length, guestOpens, 'a failed read must never open an account reader with an empty position');
          await React.act(async () => { bootstrap.retryLibraryRestore(); bootstrap.retryLibraryRestore(); });
          assert.equal(accountAttempts, 2);
          assert.equal(bootstrap.libraryRestoreFailed, false);
        }
        assert.equal(opens.length, guestOpens + 1);
        assert.ok(opens.at(-1).ownerKey.startsWith('firebase:cold-start-account'));
        assert.equal(opens.at(-1).initialPercent, 60, 'account reader captures the durable saved position');
        assert.equal(driveLoads, 0);
        if (offline) {
          network.onLine = true;
          await React.act(async () => window.dispatchEvent(new window.Event('online')));
          assert.equal(driveLoads, 1);
          assert.equal(opens.length, 1);
        }
        const accountOwner = ownerRuntime.capture();
        const previousGuestRestores = guestRestores.length;
        await React.act(async () => authCallback(null));
        assert.equal(bootstrap.flushingOutgoingProgress, true);
        assert.equal(ownerRuntime.isCurrent(accountOwner), true, 'a cross-tab sign-out must wait for the outgoing reader save');
        assert.equal(guestRestores.length, previousGuestRestores);
        await React.act(async () => resolveOutgoingFlush(false));
        assert.equal(bootstrap.outgoingProgressFailed, true);
        assert.equal(ownerRuntime.isCurrent(accountOwner), true, 'a failed save keeps the outgoing owner available for retry');
        await React.act(async () => bootstrap.retryOutgoingProgress());
        await React.act(async () => resolveOutgoingFlush(true));
        assert.equal(localStorage.getItem('isGuest'), 'true');
        assert.equal(ownerRuntime.isCurrent(accountOwner), false);
        await React.act(async () => authCallback(null));
        assert.deepEqual(guestRestores.slice(previousGuestRestores), [{
          owner: ownerRuntime.capture().ownerKey, confirmed: true, refreshFrom: accountOwner.ownerKey,
        }]);
        await React.act(async () => resolveLogoutRestore());
        await React.act(async () => authCallback({ uid: 'empty-account' }));
        assert.equal(bootstrap.isAuthenticatedLibraryReady, true, 'a successful empty read is ready');
        assert.equal(bootstrap.libraryRestoreFailed, false);
      } finally {
        window.setTimeout = originalSet;
        window.clearTimeout = originalClear;
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
      }
    });
  } finally {
    ownerRuntime.clear();
    paths.forEach((path, index) => {
      if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path];
    });
  }
});

for (const scenario of ['initial set', 'postinitial set', 'postinitial small move', 'postinitial reset', 'restore pending offer']) test(`remote ${scenario} prompt survives relocation before opening`, async () => {
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
      if (scenario === 'restore pending offer') {
        const scope = 'reader-reopen';
        const remote = { ...common.remoteProgress, acceptedEventId: 'remote-2' };
        const { getRemoteProgressIdentity } = require('../src/hooks/reader/remoteProgressAdoption.ts');
        const { writeSyncRecovery } = require('../src/lib/readerSyncRecovery.ts');
        const identity = getRemoteProgressIdentity(remote);
        assert.equal(writeSyncRecovery(scope, { identity, candidate: { identity, cfi: 'remote', percent: 80 }, noticePending: true }), true);
        const render = extra => React.act(async () => root.render(React.createElement(Harness, {
          recoveryScope: scope, localRevision: 1, currentCfi: 'local', currentAnchorCfi: 'local', totalProgress: 10,
          ...extra,
        })));
        await render({ remoteProgress: undefined });
        assert.equal(state.syncRecovery, null);
        await render({ remoteProgress: remote });
        assert.equal(state.syncRecoveryVisible, true);
        assert.equal(state.syncRecovery.identity, identity);
        assert.equal(state.syncConflict, null);
        await render({ remoteProgress: remote, localRevision: 2 });
        assert.equal(state.syncRecoveryVisible, false);
        return;
      }
      if (scenario !== 'initial set') {
        await React.act(async () => root.render(React.createElement(Harness, { remoteProgress: { ...common.remoteProgress, cfi: 'old-remote', anchorCfi: 'old-remote', lastRead: 100, syncRevision: 1 }, currentCfi: 'local-a', currentAnchorCfi: 'local-a', totalProgress: 20 })));
      }
      const incoming = scenario === 'postinitial reset'
        ? { ...common.remoteProgress, operation: 'reset', cfi: '', anchorCfi: '', progressPercent: 0 }
        : scenario === 'postinitial small move'
          ? { ...common.remoteProgress, progressPercent: 20.01 }
          : common.remoteProgress;
      await React.act(async () => root.render(React.createElement(Harness, { remoteProgress: incoming, currentCfi: 'local-a', currentAnchorCfi: 'local-a', totalProgress: 20 })));
      const scheduled = timers.size;
      await React.act(async () => root.render(React.createElement(Harness, { remoteProgress: incoming, currentCfi: 'local-b', currentAnchorCfi: 'local-b', totalProgress: scenario === 'postinitial small move' ? 20.02 : 21 })));
      const remaining = timers.size;
      await React.act(async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } });
      assert.equal(scheduled, 1);
      assert.equal(remaining, 1);
      assert.equal(state.syncConflict.operation, incoming.operation);
      assert.equal(state.syncConflict.syncRevision, 2);
      assert.equal(state.syncRecoveryVisible, false);
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

async function withServiceWorkerUpdateHarness(flushCurrentProgress, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const messages = [];
  const errors = [];
  const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: message => messages.push(message) });
  const registration = Object.assign(new EventTarget(), { waiting: worker, installing: null });
  const serviceWorker = Object.assign(new EventTarget(), { controller: {}, register: async () => registration });
  const activate = () => {
    registration.waiting = null;
    worker.state = 'activated';
    serviceWorker.controller = worker;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    serviceWorker,
  } });
  try {
    await withDom(async root => {
      const { useServiceWorkerUpdate } = require('../src/hooks/useServiceWorkerUpdate.ts');
      const api = { current: null };
      const reloads = [];
      Object.defineProperty(window, 'location', { configurable: true, value: { reload: () => reloads.push(true) } });
      function Harness() {
        const state = useServiceWorkerUpdate({ flushCurrentProgress, onPersistenceError: message => errors.push(message) });
        React.useLayoutEffect(() => { api.current = state; });
        return null;
      }
      await React.act(async () => root.render(React.createElement(Harness)));
      assert.equal(api.current.updateAvailable, true);
      await run({ api, messages, errors, worker, activate, reloads });
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
}

test('development service worker cleanup unregisters only this app and preserves stored data', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousMode = process.env.NODE_ENV;
  const previousOptIn = process.env.NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER;
  const removed = [];
  let registered = false;
  process.env.NODE_ENV = 'development';
  delete process.env.NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    serviceWorker: {
      controller: null,
      register: async () => { registered = true; },
      getRegistrations: async () => [
        { active: { scriptURL: 'http://localhost:3100/sw.js' }, unregister: async () => { removed.push('reader'); } },
        { active: { scriptURL: 'http://localhost:3100/other.js' }, unregister: async () => { removed.push('other'); } },
      ],
    },
  } });
  try {
    await withDom(async root => {
      localStorage.setItem('viewer_settings', 'saved');
      const { useServiceWorkerUpdate } = require('../src/hooks/useServiceWorkerUpdate.ts');
      function Harness() { useServiceWorkerUpdate(); return null; }
      await React.act(async () => root.render(React.createElement(Harness)));
      assert.deepEqual(removed, ['reader']);
      assert.equal(registered, false);
      assert.equal(localStorage.getItem('viewer_settings'), 'saved');
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator;
    if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
    if (previousOptIn === undefined) delete process.env.NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER;
    else process.env.NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER = previousOptIn;
  }
});

test('service worker update reports applying before saving finishes and ignores duplicate requests', async () => {
  let finishSave;
  let flushes = 0;
  const flush = new Promise(resolve => { finishSave = resolve; });
  await withServiceWorkerUpdateHarness(() => { flushes += 1; return flush; }, async ({ api, messages, errors, activate, reloads }) => {
    let application;
    await React.act(async () => { application = api.current.applyUpdate(); });
    assert.equal(api.current.isApplying, true);
    assert.equal(flushes, 1);
    assert.deepEqual(messages, []);
    assert.equal(await api.current.applyUpdate(), false);
    assert.equal(flushes, 1);
    await React.act(async () => { finishSave(true); });
    assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
    assert.equal(api.current.isApplying, true, 'busy until activation reloads the page');
    assert.deepEqual(reloads, []);
    await React.act(async () => { activate(); assert.equal(await application, true); });
    assert.deepEqual(reloads, [true]);
    assert.deepEqual(errors, []);
  });
});

test('service worker update clears applying after failures and allows an explicit retry', async () => {
  let allowSave = false;
  await withServiceWorkerUpdateHarness(async () => allowSave, async ({ api, messages, errors, worker, activate, reloads }) => {
    await React.act(async () => { assert.equal(await api.current.applyUpdate(), false); });
    assert.equal(api.current.isApplying, false);
    assert.equal(errors.length, 1);
    assert.deepEqual(messages, []);
    allowSave = true;
    worker.postMessage = () => { throw new Error('worker stopped'); };
    await React.act(async () => { assert.equal(await api.current.applyUpdate(), false); });
    assert.equal(api.current.isApplying, false);
    assert.equal(errors.length, 2);
    worker.postMessage = message => { messages.push(message); activate(); };
    await React.act(async () => { assert.equal(await api.current.applyUpdate(), true); });
    assert.equal(api.current.isApplying, false);
    assert.deepEqual(reloads, [true]);
    assert.deepEqual(messages, [{ type: 'SKIP_WAITING' }]);
  });
});

test('another tab can activate the worker without interrupting this tab’s pending save', async () => {
  const firstSave = Promise.withResolvers();
  let flush = firstSave.promise;
  await withServiceWorkerUpdateHarness(() => flush, async ({ api, activate, reloads, messages, errors }) => {
    let applying;
    await React.act(async () => { applying = api.current.applyUpdate(); });
    await React.act(async () => { activate(); });
    assert.deepEqual(reloads, []);
    assert.equal(api.current.isApplying, true);
    await React.act(async () => {
      firstSave.resolve(false);
      assert.equal(await applying, false);
    });
    assert.deepEqual(reloads, []);
    assert.equal(api.current.updateAvailable, true);
    assert.equal(api.current.isApplying, false);
    assert.equal(errors.length, 1);

    flush = Promise.resolve(true);
    await React.act(async () => { assert.equal(await api.current.applyUpdate(), true); });
    assert.deepEqual(reloads, [true]);
    assert.deepEqual(messages, []);
  });
});

test('statistics receive notifies once at exit for committed pages even when the next page fails or leadership is lost', async () => {
  const modules = [
    '../src/lib/firebase.ts', 'firebase/auth', '../src/lib/localReadingStatistics.ts',
    '../src/lib/ownerRuntime.ts', '../src/hooks/useOwnerSnapshot.ts',
    '../src/lib/readingStatisticsSync.ts', '../src/lib/readingStatisticsWake.ts',
    '../src/lib/readingStatisticsSyncLease.ts', '../src/hooks/useReadingStatisticsSync.ts',
  ];
  const paths = modules.map(name => require.resolve(name));
  const previous = paths.map(path => require.cache[path]);
  const setModule = (index, exports) => {
    const path = paths[index];
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  };
  const ownerKey = 'firebase:stats-regression|library:local';
  const owner = { ownerKey };
  const user = { uid: 'stats-regression' };
  try {
    for (const scenario of ['failure', 'lost', 'uncommitted', 'empty', 'rollup', 'success']) {
      let leader = true;
      let fetches = 0;
      let commits = 0;
      let notifications = 0;
      let finish;
      const finished = new Promise(resolve => { finish = resolve; });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const firstCursor = { uploadedAtServerSeconds: nowSeconds, uploadedAtServerNanoseconds: 0, documentId: 'first' };
      setModule(0, { auth: {}, db: {} });
      setModule(1, { onIdTokenChanged: () => noop });
      setModule(2, {
        getPendingReadingSessionsV11: async () => [],
        getReadingStatisticsHydrationPlanV12: async () => ({
          state: { cursor: firstCursor, lastFullAuditAt: Date.now(), fullHydrationCompleted: scenario !== 'rollup' },
          ...(scenario === 'rollup' ? { published: { sourceThrough: { seconds: nowSeconds, nanoseconds: 0 } } } : {}),
        }),
        hydrateRemoteReadingSessionsPageV12: async () => {
          commits++;
          if (scenario === 'lost') leader = false;
          return { quarantinedDocuments: [] };
        },
        recordReadingStatisticsHydrationMetricsV12: async () => { finish(); },
      });
      setModule(3, { ownerRuntime: { isCurrent: yes, registerDisposer: () => noop } });
      setModule(4, { useOwnerSnapshot: () => owner });
      setModule(5, { getRemoteReadingSessionsPageV1: async () => {
        fetches++;
        if (scenario === 'failure' && fetches === 2) throw new Error('next page failed');
        if (scenario === 'uncommitted') leader = false;
        const empty = scenario === 'empty' || scenario === 'rollup';
        return { sessions: empty ? [] : [{ sessionId: `remote-${fetches}` }], quarantinedDocuments: [],
          nextCursor: firstCursor, fullHydrationCompleted: empty || scenario === 'success' };
      } });
      setModule(6, {
        notifyReadingStatisticsChange: key => { assert.equal(key, ownerKey); notifications++; },
        notifyReadingStatisticsServerCheck: noop, requestReadingStatisticsRefresh: noop,
        subscribeReadingStatisticsChanges: () => noop, subscribeReadingStatisticsRefreshRequests: () => noop,
        subscribeReadingStatisticsServerChecks: () => noop,
      });
      setModule(7, { READING_STATISTICS_LEASE_HEARTBEAT_MS: 100000,
        ReadingStatisticsSyncLeaseRuntime: class {
          claim = { holderTabId: 'test', epoch: 1 };
          async acquire() { return this.claim; }
          async isCurrent() { return leader; }
          async release() {}
        } });
      delete require.cache[paths[8]];
      const { useReadingStatisticsSync } = require(paths[8]);
      await withDom(async root => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        function Harness() { useReadingStatisticsSync(user, ownerKey); return null; }
        await React.act(async () => root.render(React.createElement(Harness)));
        await React.act(async () => finished);
        assert.equal(notifications, ['failure', 'lost', 'rollup', 'success'].includes(scenario) ? 1 : 0, scenario);
        assert.equal(commits, scenario === 'uncommitted' ? 0 : 1, scenario);
        if (scenario === 'failure') assert.equal(fetches, 2);
      });
    }
  } finally {
    paths.forEach((path, index) => {
      if (previous[index]) require.cache[path] = previous[index]; else delete require.cache[path];
    });
  }
});
