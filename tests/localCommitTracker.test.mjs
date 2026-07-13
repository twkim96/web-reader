import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPendingLocalCommitCount,
  trackLocalCommit,
  waitForCurrentLocalCommits,
} from '../src/lib/localCommitTracker.ts';
import { prepareServiceWorkerUpdate } from '../src/lib/serviceWorkerUpdatePolicy.ts';

test('waits for local commits active when an update is approved', async () => {
  let resolveCommit;
  const commit = new Promise((resolve) => { resolveCommit = resolve; });
  trackLocalCommit(commit);
  let finished = false;
  const wait = waitForCurrentLocalCommits().then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(getPendingLocalCommitCount(), 1);
  resolveCommit();
  await wait;
  assert.equal(getPendingLocalCommitCount(), 0);
});

test('does not let a rejected local commit block update activation', async () => {
  const rejected = Promise.reject(new Error('quota'));
  trackLocalCommit(rejected);
  const result = await waitForCurrentLocalCommits();
  await assert.rejects(rejected, /quota/);
  assert.deepEqual(result, { ok: false, rejected: 1 });
  assert.equal(getPendingLocalCommitCount(), 0);
});

test('also waits for a follow-up commit registered while the first commit drains', async () => {
  let resolveFirst;
  let resolveSecond;
  const first = new Promise((resolve) => { resolveFirst = resolve; });
  const second = new Promise((resolve) => { resolveSecond = resolve; });
  trackLocalCommit(first.then(() => {
    trackLocalCommit(second);
  }));

  let finished = false;
  const wait = waitForCurrentLocalCommits().then(() => { finished = true; });
  resolveFirst();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(getPendingLocalCommitCount(), 1);
  resolveSecond();
  await wait;
  assert.equal(finished, true);
  assert.equal(getPendingLocalCommitCount(), 0);
});

test('returns a successful drain result when every current and follow-up commit settles', async () => {
  trackLocalCommit(Promise.resolve());
  assert.deepEqual(await waitForCurrentLocalCommits(), { ok: true, rejected: 0 });
});

test('blocks an update when reader flush or local commit drain fails', async () => {
  let drained = false;
  assert.equal(await prepareServiceWorkerUpdate({
    flushCurrentProgress: async () => false,
    drainLocalCommits: async () => {
      drained = true;
      return { ok: true, rejected: 0 };
    },
  }), false);
  assert.equal(drained, false);
  assert.equal(await prepareServiceWorkerUpdate({
    flushCurrentProgress: async () => true,
    drainLocalCommits: async () => ({ ok: false, rejected: 1 }),
  }), false);
});
