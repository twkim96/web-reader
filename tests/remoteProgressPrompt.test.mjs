import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useRemoteProgressPrompt } from '../src/hooks/reader/useRemoteProgressPrompt.ts';

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
    return navigationAttempts >= 2;
  };
  const stableOptions = {
    isLoaded: true,
    remoteProgress,
    lastSaveTimeRef,
    waitForNavigationReady: async () => true,
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

    assert.equal(navigationAttempts, 1);
    assert.equal(adoptionAttempts, 1);
    const retryEntry = [...timers.entries()].find(([, timer]) => timer.delay === 750);
    assert.ok(retryEntry, 'first navigation failure should schedule the 750ms retry');

    await act(async () => {
      root.render(React.createElement(Harness, {
        currentCfi: 'layout-relocate-cfi',
        totalProgress: 12,
        localRevision: 1,
      }));
      await flushMicrotasks();
    });

    assert.equal(navigationAttempts, 1, 'rerender while timer is pending must not consume the remote identity');
    assert.equal(adoptionAttempts, 1);
    assert.ok(timers.has(retryEntry[0]), 'rerender must leave the pending retry timer intact');

    await act(async () => {
      timers.delete(retryEntry[0]);
      retryEntry[1].callback();
      await flushMicrotasks();
    });

    assert.equal(adoptionAttempts, 2);
    assert.equal(navigationAttempts, 2, 'timer wake should execute the second canonical navigation attempt');
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
    useRemoteProgressPrompt({
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
      isQuietResumeEligible: () => true,
      isProgressConflictAutoResolveEligible: () => true,
      adoptRemoteProgressBeforeNavigation: async () => {
        adoptionAttempts += 1;
        return { status: 'cancelled' };
      },
      completeRemoteJump: async () => true,
      completeRemoteReset: async () => true,
      hasLocalProgress: true,
    });
    return null;
  };

  try {
    await act(async () => {
      root.render(React.createElement(Harness));
      await flushMicrotasks();
    });
    assert.equal(readinessCalls, 1);
    assert.equal(adoptionAttempts, 0);
    activeAttempt.controller.abort();
    await act(async () => {
      releaseReady(true);
      await flushMicrotasks();
    });
    assert.equal(adoptionAttempts, 0);
    assert.equal(navigationAttempts, 0);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
