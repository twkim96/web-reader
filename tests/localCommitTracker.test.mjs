import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPendingLocalCommitCount,
  trackLocalCommit,
  waitForCurrentLocalCommits,
} from '../src/lib/localCommitTracker.ts';

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
  await waitForCurrentLocalCommits();
  await assert.rejects(rejected, /quota/);
  assert.equal(getPendingLocalCommitCount(), 0);
});
