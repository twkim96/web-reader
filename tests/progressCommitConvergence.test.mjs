import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canApplyReloadedProgress,
  getProgressCommitConvergenceAction,
} from '../src/lib/progressCommitConvergence.ts';

const progress = (bookmarks, overrides = {}) => ({
  bookId: 'book-1',
  cfi: 'epubcfi(/6/4!/4/2/2:0)',
  anchorCfi: 'epubcfi(/6/4!/4/2/2:0)',
  progressPercent: 20,
  lastRead: 10,
  bookmarks,
  ...overrides,
});

const bookmark = (id) => ({
  id,
  type: 'manual',
  name: id,
  cfi: `cfi-${id}`,
  progressPercent: 20,
  createdAt: 10,
  color: '#f59e0b',
});

test('reloads persisted canonical when remote hydration replaced the optimistic React object', () => {
  const optimistic = progress([bookmark('local-x')]);
  const remoteDisplay = progress([bookmark('remote-y')], { syncRevision: 1 });

  assert.equal(getProgressCommitConvergenceAction({
    ownerCurrent: true,
    latestLocalWrite: true,
    currentDisplay: remoteDisplay,
    optimistic,
  }), 'reload-persisted');

  assert.equal(canApplyReloadedProgress({
    ownerCurrent: true,
    latestLocalWrite: true,
    currentDisplay: remoteDisplay,
    observedDisplay: remoteDisplay,
  }), true);
});

test('does not apply an older commit after a newer local write starts', () => {
  const optimistic = progress([bookmark('local-x')]);

  assert.equal(getProgressCommitConvergenceAction({
    ownerCurrent: true,
    latestLocalWrite: false,
    currentDisplay: optimistic,
    optimistic,
  }), 'skip');
});

test('drops a reloaded canonical if React changed again while IndexedDB was being read', () => {
  const observedRemote = progress([bookmark('remote-y')], { syncRevision: 1 });
  const newerRemote = progress([bookmark('remote-y'), bookmark('remote-z')], { syncRevision: 2 });

  assert.equal(canApplyReloadedProgress({
    ownerCurrent: true,
    latestLocalWrite: true,
    currentDisplay: newerRemote,
    observedDisplay: observedRemote,
  }), false);
});
