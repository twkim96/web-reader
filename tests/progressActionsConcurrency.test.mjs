import 'fake-indexeddb/auto';

import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useProgressActions } from '../src/hooks/useProgressActions.ts';
import { closeLocalDB } from '../src/lib/localDB.ts';
import { LOCAL_DB_NAME } from '../src/lib/localDBSchema.ts';
import {
  loadProgressFromLocalV5,
  saveProgressToLocalV5,
} from '../src/lib/localDBV5.ts';
import { ownerRuntime } from '../src/lib/ownerRuntime.ts';
import {
  makeFirebaseOwnerKey,
  makeGuestOwnerKey,
  makeOwnerKey,
} from '../src/lib/ownerIdentity.ts';
import { getOutboxEventsV5 } from '../src/lib/syncOutboxV5.ts';
import { setSyncSessionIdForTests } from '../src/lib/syncSession.ts';

const resetDatabase = async () => {
  await closeLocalDB();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(LOCAL_DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
};

const bookmark = (id, createdAt) => ({
  id,
  type: 'manual',
  name: id,
  cfi: `cfi-${id}`,
  progressPercent: 20,
  createdAt,
  color: '#f59e0b',
});

const progress = (bookmarks, overrides = {}) => ({
  bookId: 'book-1',
  cfi: 'local-cfi',
  anchorCfi: 'local-cfi',
  progressPercent: 20,
  lastRead: 10,
  bookmarks,
  ...overrides,
});

test.beforeEach(async () => {
  await resetDatabase();
  ownerRuntime.clear();
  setSyncSessionIdForTests('session-progress-actions');
});

test.after(async () => {
  ownerRuntime.clear();
  setSyncSessionIdForTests(undefined);
  await resetDatabase();
});

test('explicit local bookmark mutation converges React to transaction-current X+Y after a remote render wins the optimistic race', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.BroadcastChannel = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('progress-actions-race'), 'library:local');
  ownerRuntime.activate(ownerKey);

  const remoteY = bookmark('remote-y', 20);
  const localX = bookmark('local-x', 30);
  const remoteDisplay = progress([remoteY], {
    syncRevision: 1,
    acceptedEventId: 'remote-y-event',
  });
  const initialDisplay = progress([]);
  await saveProgressToLocalV5(ownerKey, remoteDisplay);

  let controls;
  let renderedProgress = { 'book-1': initialDisplay };
  const Harness = () => {
    const [progressState, setProgress] = useState({ 'book-1': initialDisplay });
    const progressRef = useRef({ 'book-1': initialDisplay });
    const deviceId = useRef('device-local');
    const actions = useProgressActions({
      activeBook: { id: 'book-1' },
      user: { uid: 'progress-actions-race' },
      deviceId,
      progressRef,
      setProgress,
    });
    useEffect(() => {
      renderedProgress = progressState;
      controls = { actions, progressRef, setProgress };
    }, [actions, progressState]);
    return null;
  };

  const root = createRoot(window.document.getElementById('app'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    let commit;
    await act(async () => {
      commit = controls.actions.saveBookmarkMutation('book-1', {
        kind: 'upsert',
        bookmark: localX,
      });

      controls.progressRef.current = {
        ...controls.progressRef.current,
        'book-1': remoteDisplay,
      };
      controls.setProgress((prev) => ({ ...prev, 'book-1': remoteDisplay }));
      assert.equal(await commit, true);
    });

    const stored = await loadProgressFromLocalV5(ownerKey, 'book-1');
    assert.deepEqual(stored.bookmarks.map(({ id }) => id), ['local-x', 'remote-y']);
    assert.deepEqual(renderedProgress['book-1'].bookmarks.map(({ id }) => id), ['local-x', 'remote-y']);

    const bookmarkEvents = (await getOutboxEventsV5(ownerKey))
      .filter((event) => event.target.kind === 'bookmark');
    assert.equal(bookmarkEvents.length, 1);
    assert.equal(bookmarkEvents[0].operation, 'bookmark.upsert');
    assert.equal(bookmarkEvents[0].target.bookmarkId, 'local-x');
  } finally {
    await act(async () => {
      root.unmount();
    });
    ownerRuntime.clear();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.CustomEvent = previousCustomEvent;
    globalThis.BroadcastChannel = previousBroadcastChannel;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('guest stale position save preserves manual bookmarks committed after the relocate snapshot', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.BroadcastChannel = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const ownerKey = makeOwnerKey(makeGuestOwnerKey('progress-actions-guest'), 'library:local');
  ownerRuntime.activate(ownerKey);

  const initialDisplay = progress([]);
  const staleRelocateBookmarks = initialDisplay.bookmarks;
  const localX = bookmark('local-x', 30);
  const localY = bookmark('local-y', 40);
  await saveProgressToLocalV5(ownerKey, initialDisplay);

  let controls;
  let renderedProgress = { 'book-1': initialDisplay };
  const Harness = () => {
    const [progressState, setProgress] = useState({ 'book-1': initialDisplay });
    const progressRef = useRef({ 'book-1': initialDisplay });
    const deviceId = useRef('device-guest');
    const actions = useProgressActions({
      activeBook: { id: 'book-1' },
      user: null,
      deviceId,
      progressRef,
      setProgress,
    });
    useEffect(() => {
      renderedProgress = progressState;
      controls = { actions, progressRef };
    }, [actions, progressState]);
    return null;
  };

  const root = createRoot(window.document.getElementById('app'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      assert.equal(await controls.actions.saveBookmarkMutation('book-1', {
        kind: 'upsert',
        bookmark: localX,
      }), true);
      assert.equal(await controls.actions.saveBookmarkMutation('book-1', {
        kind: 'upsert',
        bookmark: localY,
      }), true);
      assert.equal(await controls.actions.saveProgress(
        'stale-relocate-cfi',
        35,
        staleRelocateBookmarks,
        { force: true },
      ), true);
    });

    const stored = await loadProgressFromLocalV5(ownerKey, 'book-1');
    assert.equal(stored.cfi, 'stale-relocate-cfi');
    assert.deepEqual(stored.bookmarks.map(({ id }) => id), ['local-y', 'local-x']);
    assert.deepEqual(renderedProgress['book-1'].bookmarks.map(({ id }) => id), ['local-y', 'local-x']);
    assert.deepEqual(await getOutboxEventsV5(ownerKey), []);
  } finally {
    await act(async () => {
      root.unmount();
    });
    ownerRuntime.clear();
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.CustomEvent = previousCustomEvent;
    globalThis.BroadcastChannel = previousBroadcastChannel;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test('durable bookmark commit stays successful when the first convergence read fails and later reconciles', async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousBroadcastChannel = globalThis.BroadcastChannel;
  const previousWarn = console.warn;
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.BroadcastChannel = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const warnings = [];
  console.warn = (...args) => { warnings.push(args); };

  const ownerKey = makeOwnerKey(makeFirebaseOwnerKey('progress-actions-deferred'), 'library:local');
  ownerRuntime.activate(ownerKey);

  const remoteY = bookmark('remote-y', 20);
  const localX = bookmark('local-x', 30);
  const remoteDisplay = progress([remoteY], {
    syncRevision: 1,
    acceptedEventId: 'remote-y-event',
  });
  const initialDisplay = progress([]);
  await saveProgressToLocalV5(ownerKey, remoteDisplay);

  let convergenceReads = 0;
  const loadProgressForConvergence = async (targetOwnerKey, bookId) => {
    convergenceReads += 1;
    if (convergenceReads === 1) throw new Error('forced convergence read failure');
    return loadProgressFromLocalV5(targetOwnerKey, bookId);
  };

  let controls;
  let renderedProgress = { 'book-1': initialDisplay };
  const Harness = () => {
    const [progressState, setProgress] = useState({ 'book-1': initialDisplay });
    const progressRef = useRef({ 'book-1': initialDisplay });
    const deviceId = useRef('device-local');
    const actions = useProgressActions({
      activeBook: { id: 'book-1' },
      user: { uid: 'progress-actions-deferred' },
      deviceId,
      progressRef,
      setProgress,
      loadProgressForConvergence,
      convergenceRetryDelaysMs: [5],
    });
    useEffect(() => {
      renderedProgress = progressState;
      controls = { actions, progressRef, setProgress };
    }, [actions, progressState]);
    return null;
  };

  const root = createRoot(window.document.getElementById('app'));
  try {
    await act(async () => {
      root.render(React.createElement(Harness));
    });

    let commit;
    let committed;
    await act(async () => {
      commit = controls.actions.saveBookmarkMutation('book-1', {
        kind: 'upsert',
        bookmark: localX,
      });

      controls.progressRef.current = {
        ...controls.progressRef.current,
        'book-1': remoteDisplay,
      };
      controls.setProgress((prev) => ({ ...prev, 'book-1': remoteDisplay }));
      committed = await commit;
    });

    assert.equal(committed, true);
    assert.equal(convergenceReads, 1);
    assert.deepEqual(renderedProgress['book-1'].bookmarks.map(({ id }) => id), ['remote-y']);

    const storedAfterCommit = await loadProgressFromLocalV5(ownerKey, 'book-1');
    assert.deepEqual(storedAfterCommit.bookmarks.map(({ id }) => id), ['local-x', 'remote-y']);
    const bookmarkEvents = (await getOutboxEventsV5(ownerKey))
      .filter((event) => event.target.kind === 'bookmark');
    assert.equal(bookmarkEvents.length, 1);
    assert.equal(bookmarkEvents[0].target.bookmarkId, 'local-x');

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    assert.equal(convergenceReads, 2);
    assert.deepEqual(renderedProgress['book-1'].bookmarks.map(({ id }) => id), ['local-x', 'remote-y']);
    assert.ok(warnings.some(([message]) => String(message).includes('canonical reload deferred')));
  } finally {
    await act(async () => {
      root.unmount();
    });
    ownerRuntime.clear();
    console.warn = previousWarn;
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.CustomEvent = previousCustomEvent;
    globalThis.BroadcastChannel = previousBroadcastChannel;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
