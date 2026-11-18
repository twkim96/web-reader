import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useRemoteProgressPrompt } from '../src/hooks/reader/useRemoteProgressPrompt.ts';
import { SyncRecoveryNotice } from '../src/components/reader/SyncRecoveryNotice.tsx';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

test('pending automatic retry survives reader rerenders until its timer wakes the next navigation attempt', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let nextTimerId = 1;
  const timers = new Map();
  window.setTimeout = (callback, delay = 0) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  window.clearTimeout = (timerId) => {
    timers.delete(timerId);
  };

  const remoteProgress = {
    operation: 'set',
    bookId: 'book-1',
    cfi: 'remote-cfi',
    anchorCfi: 'remote-cfi',
    progressPercent: 70,
    lastRead: 100,
    bookmarks: [],
    syncRevision: 1,
    acceptedEventId: 'remote-event-1',
  };
  const adoptedProgress = {
    bookId: remoteProgress.bookId,
    cfi: remoteProgress.cfi,
    anchorCfi: remoteProgress.anchorCfi,
    progressPercent: remoteProgress.progressPercent,
    lastRead: remoteProgress.lastRead,
    bookmarks: [],
    syncRevision: remoteProgress.syncRevision,
    acceptedEventId: remoteProgress.acceptedEventId,
  };
  const lastSaveTimeRef = { current: 0 };
  let navigationAttempts = 0;
  let adoptionAttempts = 0;
  let preparationId = 0;
  let attemptId = 0;
  let activeAttempt = null;

  const navigate = async () => {
    navigationAttempts += 1;
    return true;
  };
  let readinessAttempts = 0;
  const stableOptions = {
    isLoaded: true,
    remoteProgress,
    lastSaveTimeRef,
    waitForNavigationReady: async () => ++readinessAttempts >= 2,
    goTo: navigate,
    goToStable: navigate,
    goToFraction: async () => true,
    goToFractionStable: async () => true,
    getBookmarks: () => [],
    adoptResolvedBookmarks: (bookmarks) => bookmarks,
    stageAutoBookmark: () => [],
    commitBookmarks: (bookmarks) => bookmarks,
    prepareRemoteJump: () => {
      preparationId += 1;
      return preparationId;
    },
    prepareRemoteRollback: () => true,
    cancelRemoteJump: () => {},
    finishRemoteJump: () => {},
    beginRemoteNavigationAttempt: () => {
      attemptId += 1;
      const controller = new AbortController();
      activeAttempt = { id: attemptId, interactionGeneration: 0, signal: controller.signal, controller };
      return activeAttempt;
    },
    isRemoteNavigationAttemptCurrent: (attempt) => activeAttempt?.id === attempt.id
      && !attempt.signal.aborted,
    finishRemoteNavigationAttempt: (attempt) => {
      if (activeAttempt?.id === attempt.id) activeAttempt = null;
    },
    isQuietResumeEligible: () => true,
    isProgressConflictAutoResolveEligible: () => true,
    adoptRemoteProgressBeforeNavigation: async () => {
      adoptionAttempts += 1;
      return { status: 'adopted', progress: adoptedProgress };
    },
    completeRemoteJump: async () => true,
    completeRemoteReset: async () => true,
    hasLocalProgress: true,
  };

  const Harness = ({ currentCfi, totalProgress, localRevision }) => {
    useRemoteProgressPrompt({
      ...stableOptions,
      currentCfi,
      currentAnchorCfi: currentCfi,
      totalProgress,
      localRevision,
    });
    return null;
  };

  const root = createRoot(window.document.getElementById('app'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness, {
        currentCfi: 'local-cfi',
        totalProgress: 10,
        localRevision: 0,
      }));
      await flushMicrotasks();
    });

    assert.equal(navigationAttempts, 0);
    assert.equal(adoptionAttempts, 0);
    const retryEntry = [...timers.entries()].find(([, timer]) => timer.delay === 750);
    assert.ok(retryEntry, 'readiness failure should schedule the 750ms retry');

    await act(async () => {
      root.render(React.createElement(Harness, {
        currentCfi: 'layout-relocate-cfi',
        totalProgress: 12,
        localRevision: 1,
      }));
      await flushMicrotasks();
    });

    assert.equal(navigationAttempts, 0, 'rerender while timer is pending must not consume the remote identity');
    assert.equal(adoptionAttempts, 0);
    assert.ok(timers.has(retryEntry[0]), 'rerender must leave the pending retry timer intact');

    await act(async () => {
      timers.delete(retryEntry[0]);
      retryEntry[1].callback();
      await flushMicrotasks();
    });

    assert.equal(adoptionAttempts, 1);
    assert.equal(navigationAttempts, 1, 'timer wake should execute the second canonical navigation attempt');
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('user progress input during readiness cancels automatic adoption before canonical commit', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let quiet = true;
  let state;
  let releaseReady;
  let readinessCalls = 0;
  let adoptionAttempts = 0;
  let navigationAttempts = 0;
  let attemptId = 0;
  let activeAttempt = null;
  const ready = new Promise((resolve) => {
    releaseReady = resolve;
  });
  const remoteProgress = {
    operation: 'set',
    bookId: 'book-1',
    cfi: 'remote-cfi',
    anchorCfi: 'remote-cfi',
    progressPercent: 70,
    lastRead: 100,
    bookmarks: [],
    syncRevision: 1,
    acceptedEventId: 'remote-event-1',
  };
  const root = createRoot(window.document.getElementById('app'));
  const Harness = () => {
    const nextState = useRemoteProgressPrompt({
      isLoaded: true,
      remoteProgress,
      currentCfi: 'local-cfi',
      currentAnchorCfi: 'local-cfi',
      totalProgress: 10,
      localRevision: 0,
      lastSaveTimeRef: { current: 0 },
      waitForNavigationReady: async () => {
        readinessCalls += 1;
        return ready;
      },
      goTo: async () => true,
      goToStable: async () => {
        navigationAttempts += 1;
        return true;
      },
      goToFraction: async () => true,
      goToFractionStable: async () => true,
      getBookmarks: () => [],
      adoptResolvedBookmarks: (bookmarks) => bookmarks,
      stageAutoBookmark: () => [],
      commitBookmarks: (bookmarks) => bookmarks,
      prepareRemoteJump: () => 1,
      prepareRemoteRollback: () => true,
      cancelRemoteJump: () => {},
      finishRemoteJump: () => {},
      beginRemoteNavigationAttempt: () => {
        attemptId += 1;
        const controller = new AbortController();
        activeAttempt = { id: attemptId, interactionGeneration: 0, signal: controller.signal, controller };
        return activeAttempt;
      },
      isRemoteNavigationAttemptCurrent: (attempt) => activeAttempt?.id === attempt.id
        && !attempt.signal.aborted,
      finishRemoteNavigationAttempt: (attempt) => {
        if (activeAttempt?.id === attempt.id) activeAttempt = null;
      },
      isQuietResumeEligible: () => quiet,
      isProgressConflictAutoResolveEligible: () => true,
      adoptRemoteProgressBeforeNavigation: async () => {
        adoptionAttempts += 1;
        return { status: 'cancelled' };
      },
      completeRemoteJump: async () => true,
      completeRemoteReset: async () => true,
      hasLocalProgress: true,
    });
    React.useEffect(() => { state = nextState; }, [nextState]);
    return null;
  };

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushMicrotasks();
    });
    assert.equal(readinessCalls, 1);
    assert.equal(adoptionAttempts, 0);
    quiet = false;
    activeAttempt.controller.abort();
    await act(async () => {
      releaseReady(true);
      await flushMicrotasks();
    });
    assert.equal(adoptionAttempts, 0);
    assert.equal(navigationAttempts, 0);
    assert.equal(state.syncRecoveryVisible, true);
    assert.equal(state.syncRecovery.cfi, 'remote-cfi');
    assert.equal(state.syncConflict, null);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('remote move prompt uses the newest position on click and stays open while local work is syncing', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let nextTimerId = 1;
  const timers = new Map();
  window.setTimeout = (callback, delay = 0) => {
    const timerId = nextTimerId;
    nextTimerId += 1;
    timers.set(timerId, { callback, delay });
    return timerId;
  };
  window.clearTimeout = (timerId) => {
    timers.delete(timerId);
  };

  const remoteProgress = {
    operation: 'set',
    bookId: 'book-1',
    cfi: 'remote-cfi',
    anchorCfi: 'remote-cfi',
    progressPercent: 70,
    lastRead: 100,
    bookmarks: [],
    syncRevision: 2,
    acceptedEventId: 'remote-event-2',
  };
  const adoptedRevisions = [];
  const navigationTargets = [];
  let navigationGate;
  let localPending = true;
  let adoptionAttempts = 0;
  let navigationAttempts = 0;
  let attemptId = 0;
  let activeAttempt = null;

  const Harness = ({ incoming = remoteProgress }) => {
    const state = useRemoteProgressPrompt({
      isLoaded: true,
      remoteProgress: incoming,
      currentCfi: 'local-after-turn',
      currentAnchorCfi: 'local-after-turn',
      totalProgress: 22,
      localRevision: 1,
      lastSaveTimeRef: { current: 50 },
      waitForNavigationReady: async () => true,
      goToStable: async (cfi) => {
        navigationAttempts += 1;
        navigationTargets.push(cfi);
        if (navigationGate) await navigationGate;
        return true;
      },
      goToFractionStable: async () => true,
      getBookmarks: () => [],
      adoptResolvedBookmarks: (bookmarks) => bookmarks,
      stageAutoBookmark: () => [],
      commitBookmarks: (bookmarks) => bookmarks,
      prepareRemoteJump: () => 1,
      prepareRemoteRollback: () => true,
      cancelRemoteJump: () => {},
      finishRemoteJump: () => {},
      beginRemoteNavigationAttempt: () => {
        attemptId += 1;
        const controller = new AbortController();
        activeAttempt = { id: attemptId, interactionGeneration: 0, signal: controller.signal, controller };
        return activeAttempt;
      },
      isRemoteNavigationAttemptCurrent: (attempt) => activeAttempt?.id === attempt.id
        && !attempt.signal.aborted,
      finishRemoteNavigationAttempt: (attempt) => {
        if (activeAttempt?.id === attempt.id) activeAttempt = null;
      },
      isQuietResumeEligible: () => false,
      isProgressConflictAutoResolveEligible: () => false,
      adoptRemoteProgressBeforeNavigation: async (incoming) => {
        adoptionAttempts += 1;
        adoptedRevisions.push(incoming.syncRevision);
        if (!localPending) return { status: 'adopted', progress: incoming };
        return {
          status: 'blocked-by-local-work',
          work: { pending: 1, inFlight: 0, blocked: 0, conflicts: 0, paused: 0 },
        };
      },
      completeRemoteJump: async () => true,
      completeRemoteReset: async () => true,
      hasLocalProgress: true,
    });
    return React.createElement(
      'div',
      {
        'data-conflict': state.syncConflict ? 'open' : 'closed',
        'data-target-revision': state.syncConflict?.syncRevision ?? '',
        'data-feedback': state.syncConflictFeedback ?? '',
        'data-offer': state.syncRecoveryVisible ? 'visible' : 'hidden',
      },
      React.createElement('button', { id: 'accept', onClick: state.acceptSyncConflict }, 'accept'),
    );
  };

  const root = createRoot(window.document.getElementById('app'));
  const openPrompt = () => act(async () => {
    for (const [id, timer] of timers) {
      if (timer.delay !== 0) continue;
      timers.delete(id);
      timer.callback();
    }
  });
  try {
    await act(async () => {
      root.render(React.createElement(Harness, { incoming: { ...remoteProgress, syncRevision: 1 } }));
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushMicrotasks();
    });
    await openPrompt();
    const stateNode = window.document.querySelector('[data-conflict]');
    assert.equal(stateNode?.getAttribute('data-conflict'), 'open');
    assert.equal(stateNode?.getAttribute('data-target-revision'), '2');
    assert.equal(stateNode?.getAttribute('data-offer'), 'hidden');
    assert.equal(adoptionAttempts, 0);
    const clickMove = () => act(async () => {
      window.document.getElementById('accept')?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await flushMicrotasks();
    });
    await clickMove();
    assert.equal(adoptionAttempts, 1);
    assert.equal(navigationAttempts, 0);
    assert.equal(stateNode?.getAttribute('data-conflict'), 'open');
    assert.match(stateNode?.getAttribute('data-feedback') ?? '', /저장·동기화 중/);
    localPending = false;
    const newer = { ...remoteProgress, cfi: 'newer-cfi', anchorCfi: 'newer-cfi', syncRevision: 3, acceptedEventId: 'remote-event-3' };
    await act(async () => root.render(React.createElement(Harness, { incoming: newer })));
    assert.equal(stateNode?.getAttribute('data-target-revision'), '3');
    assert.equal(navigationAttempts, 0);
    await clickMove();
    assert.deepEqual(adoptedRevisions, [2, 3]);
    assert.equal(navigationAttempts, 1);
    assert.deepEqual(navigationTargets, ['newer-cfi']);
    assert.equal(stateNode?.getAttribute('data-conflict'), 'closed');

    const offered = { ...remoteProgress, syncRevision: 4, acceptedEventId: 'remote-event-4' };
    const latest = { ...offered, syncRevision: 5, acceptedEventId: 'remote-event-5',
      cfi: 'local-after-turn', anchorCfi: 'local-after-turn', progressPercent: 22 };
    let releaseNavigation;
    navigationGate = new Promise((resolve) => { releaseNavigation = resolve; });
    await act(async () => root.render(React.createElement(Harness, { incoming: offered })));
    await openPrompt();
    await clickMove();
    assert.deepEqual(adoptedRevisions, [2, 3, 4]);
    await act(async () => root.render(React.createElement(Harness, { incoming: latest })));
    await act(async () => { releaseNavigation(); await flushMicrotasks(); });
    assert.equal(stateNode?.getAttribute('data-conflict'), 'open');
    assert.equal(stateNode?.getAttribute('data-target-revision'), '5');
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('a startup position blocked by a pending save survives dismissal without reopening its notice', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const stored = new Map();
  window.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
  const incoming = { operation: 'set', bookId: 'book', cfi: 'remote', anchorCfi: 'remote-anchor', progressPercent: 70, lastRead: 200, syncRevision: 2, acceptedEventId: 'event-2' };
  let state;
  let adoptionCalls = 0;
  const options = {
    isLoaded: true, recoveryScope: 'owner-a/book', remoteProgress: incoming,
    currentCfi: 'user-moved', currentAnchorCfi: 'user-moved', totalProgress: 25, localRevision: 1,
    lastSaveTimeRef: { current: 100 }, isQuietResumeEligible: () => true,
    isProgressConflictAutoResolveEligible: () => true, hasLocalProgress: true,
    getBookmarks: () => [],
    waitForNavigationReady: async () => true,
    beginRemoteNavigationAttempt: () => ({ id: 1, signal: new AbortController().signal }),
    isRemoteNavigationAttemptCurrent: () => true,
    finishRemoteNavigationAttempt: () => {},
    adoptRemoteProgressBeforeNavigation: async () => {
      adoptionCalls++;
      return { status: 'blocked-by-local-work', work: { pending: 1 } };
    },
    goToStable: async () => assert.fail('must not move without a click'),
  };
  function Harness({ scope = 'owner-a/book' }) {
    const nextState = useRemoteProgressPrompt({ ...options, recoveryScope: scope });
    React.useEffect(() => { state = nextState; }, [nextState]);
    return null;
  }
  let root = createRoot(document.getElementById('app'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(state.syncConflict, null);
    assert.equal(state.syncRecoveryVisible, true);
    assert.equal(state.syncRecovery.cfi, 'remote-anchor');
    assert.equal(adoptionCalls, 1);
    const identity = state.syncRecovery.identity;
    await act(async () => state.hideSyncRecovery());
    assert.equal(state.syncRecoveryVisible, false);
    assert.equal(state.syncRecovery.cfi, 'remote-anchor');
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('app'));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(state.syncRecoveryVisible, false);
    assert.equal(state.syncRecovery.cfi, 'remote-anchor');
    assert.equal(adoptionCalls, 1);
    await act(async () => state.consumeSyncRecovery('obsolete-identity'));
    assert.ok(state.syncRecovery, 'old completion cannot erase a newer candidate');
    await act(async () => state.consumeSyncRecovery(identity));
    assert.equal(state.syncRecovery, null);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('app'));
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(state.syncRecovery, null);
    assert.equal(state.syncRecoveryVisible, false);
    await act(async () => root.unmount());
    root = createRoot(document.getElementById('app'));
    await act(async () => root.render(React.createElement(Harness, { scope: 'owner-b/book' })));
    assert.equal(state.syncRecoveryVisible, true, 'another owner must not inherit the first owner dismissal');
    assert.equal(adoptionCalls, 2);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test('recovery notice expires without navigating and moves only on explicit click', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const originalTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const timers = new Map();
  let id = 0;
  window.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  window.clearTimeout = key => timers.delete(key);
  let moves = 0;
  let dismissals = 0;
  const root = createRoot(document.getElementById('app'));
  const props = { visible: true, busy: false, onMove: () => { moves++; }, onDismiss: () => { dismissals++; } };
  try {
    await act(async () => root.render(React.createElement(SyncRecoveryNotice, props)));
    assert.equal(document.querySelector('[aria-modal="true"]'), null);
    assert.equal(moves, 0);
    const expiry = [...timers.values()].sort((a, b) => b.delay - a.delay)[0];
    await act(async () => expiry.callback());
    assert.equal(dismissals, 1);
    assert.equal(moves, 0);
    const move = [...document.querySelectorAll('button')].find(button => button.textContent.includes('동기화 지점으로 이동'));
    await act(async () => move.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.equal(moves, 1);
    await act(async () => root.render(React.createElement(SyncRecoveryNotice, { ...props, busy: true })));
    assert.equal(document.querySelector('button').disabled, true);
    assert.equal(timers.size, 0, 'expiry must stop while navigation is pending');
  } finally {
    await act(async () => root.unmount());
    window.setTimeout = originalTimeout;
    window.clearTimeout = originalClearTimeout;
    Object.assign(globalThis, previous);
  }
});

test('open remote prompt follows newer heads and ignores an obsolete in-flight result', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay = 0) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  const head = (revision, overrides = {}) => ({ operation: 'set', bookId: 'book', cfi: `remote-${revision}`, anchorCfi: `remote-${revision}`, progressPercent: 70, lastRead: revision * 100, syncRevision: revision, acceptedEventId: `event-${revision}`, ...overrides });
  let resolveAdoption;
  let resolveIgnore;
  const adopted = [];
  let moves = 0;
  let ready = true;
  const completed = [];
  let activeAttempt;
  let attemptId = 0;
  const options = {
    isLoaded: true, currentCfi: 'local', currentAnchorCfi: 'local', totalProgress: 20, localRevision: 1,
    lastSaveTimeRef: { current: 0 }, hasLocalProgress: true,
    waitForNavigationReady: async () => ready, goToStable: async () => { moves++; return true; },
    goToFractionStable: async () => { moves++; return true; }, getBookmarks: () => [],
    adoptResolvedBookmarks: value => value, stageAutoBookmark: () => [], commitBookmarks: value => value,
    prepareRemoteJump: () => 1, prepareRemoteRollback: () => true, cancelRemoteJump: () => {}, finishRemoteJump: () => {},
    beginRemoteNavigationAttempt: () => { const controller = new AbortController(); activeAttempt = { id: ++attemptId, interactionGeneration: 0, signal: controller.signal }; return activeAttempt; },
    isRemoteNavigationAttemptCurrent: attempt => activeAttempt?.id === attempt.id,
    finishRemoteNavigationAttempt: attempt => { if (activeAttempt?.id === attempt.id) activeAttempt = null; },
    isQuietResumeEligible: () => false, isProgressConflictAutoResolveEligible: () => false,
    adoptRemoteProgressBeforeNavigation: progress => { adopted.push(progress); return new Promise(resolve => { resolveAdoption = resolve; }); },
    completeRemoteJump: async target => { completed.push(target); return true; }, completeRemoteReset: async () => true,
    onIgnoreRemoteProgress: () => new Promise(resolve => { resolveIgnore = resolve; }),
  };
  function Harness({ incoming, command, localRevision = 1 }) {
    const state = useRemoteProgressPrompt({ ...options, localRevision, remoteProgress: incoming, resolvedRemoteProgressCommand: command });
    return React.createElement('div', { id: 'state', 'data-revision': state.syncConflict?.syncRevision ?? '', 'data-operation': state.syncConflict?.operation ?? '', 'data-command': state.syncConflict?.resolutionCommandId ?? '', 'data-feedback': state.syncConflictFeedback ?? '' },
      React.createElement('button', { id: 'accept-new-head', onClick: state.acceptSyncConflict }),
      React.createElement('button', { id: 'dismiss-new-head', onClick: state.dismissSyncConflict }));
  }
  const root = createRoot(document.getElementById('app'));
  const render = async (incoming, command, localRevision) => { await act(async () => { root.render(React.createElement(Harness, { incoming, command, localRevision })); await flushMicrotasks(); }); };
  const click = async id => { await act(async () => { document.getElementById(id).dispatchEvent(new window.Event('click', { bubbles: true })); await flushMicrotasks(); }); };
  const state = () => document.getElementById('state');
  try {
    await render(head(1));
    await render(head(2, { operation: 'reset', cfi: '', anchorCfi: '', progressPercent: 0 }));
    const timer = [...timers.entries()].find(([, value]) => value.delay === 0);
    assert.ok(timer);
    await act(async () => { timers.delete(timer[0]); timer[1].callback(); });
    assert.equal(state().getAttribute('data-revision'), '2');
    await render(head(3, { cfi: 'local', anchorCfi: 'local', progressPercent: 20 }));
    assert.equal(state().getAttribute('data-revision'), '3', 'same-anchor head replaces the open target');
    await render(head(4, { progressPercent: 21 }), undefined, 10);
    assert.equal(state().getAttribute('data-revision'), '4', 'small update replaces it even when local revision is higher');
    assert.equal(adopted.length, 0);
    assert.equal(moves, 0);
    await click('accept-new-head');
    assert.equal(adopted[0].syncRevision, 4);
    await render(head(5, { operation: 'reset', cfi: '', anchorCfi: '', progressPercent: 0 }));
    assert.equal(state().getAttribute('data-revision'), '5');
    assert.equal(state().getAttribute('data-operation'), 'reset');
    await act(async () => { resolveAdoption({ status: 'stale-remote' }); await flushMicrotasks(); });
    assert.equal(state().getAttribute('data-revision'), '5');
    assert.equal(state().getAttribute('data-feedback'), '', 'obsolete result must not overwrite newer target feedback');
    await click('accept-new-head');
    assert.equal(adopted[1].syncRevision, 5);
    assert.equal(adopted[1].operation, 'reset');
    await act(async () => { resolveAdoption({ status: 'stale-remote' }); await flushMicrotasks(); });
    assert.match(state().getAttribute('data-feedback'), /클라우드 위치가 갱신/);
    await render(head(6, { cfi: 'local', anchorCfi: 'local', progressPercent: 20 }));
    assert.equal(state().getAttribute('data-revision'), '6', 'stale response becomes retryable when props catch up');
    await click('accept-new-head');
    assert.equal(adopted[2].syncRevision, 6);
    await act(async () => { resolveAdoption({ status: 'stale-remote' }); await flushMicrotasks(); });
    await click('dismiss-new-head');
    await render(head(7));
    await act(async () => { resolveIgnore(true); await flushMicrotasks(); });
    assert.equal(state().getAttribute('data-revision'), '7', 'late dismissal cannot close the newer prompt');
    await click('dismiss-new-head');
    await act(async () => { resolveIgnore(true); await flushMicrotasks(); });
    assert.equal(state().getAttribute('data-revision'), '');
    await render(head(8, { cfi: 'local', anchorCfi: 'local', progressPercent: 20 }));
    assert.equal(state().getAttribute('data-revision'), '', 'ignored update does not resurrect dismissed dialog');
    assert.equal(moves, 0);
    ready = false;
    const command = { commandId: 'manual-command', operation: 'jump', progress: head(9), committed: true };
    await render(head(8), command);
    assert.equal(state().getAttribute('data-command'), 'manual-command');
    await render(head(10), command);
    assert.equal(state().getAttribute('data-revision'), '9', 'remote updates must not replace a resolution command');
    ready = true;
    await click('accept-new-head');
    assert.equal(completed[0].resolutionCommandId, 'manual-command');
    assert.equal(completed[0].syncRevision, 9);
    assert.equal(state().getAttribute('data-command'), '');
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});

test('adopted head with failed renderer remains actionable after local revision catches up', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const remote = { operation: 'set', bookId: 'book', cfi: 'remote', progressPercent: 80, lastRead: 10, syncRevision: 2, acceptedEventId: 'e2' };
  let state, moves = 0, ignored = 0, releaseAllowed = false;
  const common = { isLoaded: true, remoteProgress: remote, currentCfi: 'local', currentAnchorCfi: 'local', totalProgress: 10, lastSaveTimeRef: { current: 0 }, hasLocalProgress: true,
    waitForNavigationReady: async () => true, goToStable: async () => { moves++; return false; }, goToFractionStable: async () => false,
    getBookmarks: () => [], adoptResolvedBookmarks: x => x, stageAutoBookmark: () => [], commitBookmarks: x => x,
    prepareRemoteJump: () => 1, prepareRemoteRollback: () => true, cancelRemoteJump: () => {}, finishRemoteJump: () => {},
    beginRemoteNavigationAttempt: () => ({ id: 1, interactionGeneration: 0, signal: new AbortController().signal }),
    isRemoteNavigationAttemptCurrent: () => true, finishRemoteNavigationAttempt: () => {},
    isQuietResumeEligible: () => true, isProgressConflictAutoResolveEligible: () => true,
    adoptRemoteProgressBeforeNavigation: async () => ({ status: 'adopted', progress: remote }),
    completeRemoteJump: async () => true, completeRemoteReset: async () => true,
    onIgnoreRemoteProgress: async () => { ignored++; return releaseAllowed; },
  };
  function Harness({ localRevision }) { const next = useRemoteProgressPrompt({ ...common, localRevision }); React.useEffect(() => { state = next; }, [next]); return null; }
  const root = createRoot(document.getElementById('app'));
  try {
    await act(async () => { root.render(React.createElement(Harness, { localRevision: 1 })); await flushMicrotasks(); });
    assert.equal(moves, 1);
    assert.equal(state.syncConflict?.syncRevision, 2);
    assert.match(state.syncConflictFeedback, /화면 이동에 실패/);
    await act(async () => { root.render(React.createElement(Harness, { localRevision: 2 })); await flushMicrotasks(); });
    assert.equal(state.syncConflict?.syncRevision, 2);
    await act(async () => { await state.dismissSyncConflict(); });
    assert.equal(ignored, 1);
    assert.equal(state.syncConflict?.syncRevision, 2, 'failed guard release keeps the visible choice');
    releaseAllowed = true;
    await act(async () => { await state.dismissSyncConflict(); });
    assert.equal(ignored, 2);
    assert.equal(state.syncConflict, null);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, { window: previous.window, document: previous.document, IS_REACT_ACT_ENVIRONMENT: previous.act }); }
});
