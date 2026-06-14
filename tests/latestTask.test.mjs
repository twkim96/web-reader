import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LatestFrame,
  LatestTask,
  createAbortError,
  isAbortError,
} from '../public/foliate-js/latest-task.js';

const delay = (milliseconds, value) => new Promise((resolve) => {
  setTimeout(() => resolve(value), milliseconds);
});

const createNavigator = () => {
  const latest = new LatestTask();
  const commits = [];

  const navigate = async (loader) => {
    const task = latest.begin();
    try {
      const value = await loader();
      if (!latest.isCurrent(task)) throw createAbortError();
      commits.push(value);
      latest.finish(task);
      return value;
    } catch (error) {
      if (!isAbortError(error)) throw error;
      return null;
    }
  };

  return { commits, latest, navigate };
};

test('only the last next-prev request commits after out-of-order loads', async () => {
  const { commits, navigate } = createNavigator();
  const next = navigate(() => delay(30, 'next'));
  const previous = navigate(() => delay(5, 'previous'));

  assert.deepEqual(await Promise.all([next, previous]), [null, 'previous']);
  assert.deepEqual(commits, ['previous']);
});

test('only the last request commits during repeated next navigation', async () => {
  const { commits, navigate } = createNavigator();
  const requests = [
    navigate(() => delay(30, 'page-1')),
    navigate(() => delay(20, 'page-2')),
    navigate(() => delay(5, 'page-3')),
  ];

  assert.deepEqual(await Promise.all(requests), [null, null, 'page-3']);
  assert.deepEqual(commits, ['page-3']);
});

test('cancel invalidates an unfinished request without a commit', async () => {
  const { commits, latest, navigate } = createNavigator();
  const request = navigate(() => delay(5, 'stale'));
  latest.cancel();

  assert.equal(await request, null);
  assert.deepEqual(commits, []);
});

test('coalesces resize work into one frame and runs the latest scale', async () => {
  const callbacks = new Map();
  let nextFrame = 1;
  const frame = new LatestFrame({
    requestFrame: (callback) => {
      const id = nextFrame++;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id) => callbacks.delete(id),
  });
  const rendered = [];

  const first = frame.schedule(() => rendered.push(1));
  const second = frame.schedule(() => rendered.push(2));
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value();
  await Promise.all([first, second]);

  assert.deepEqual(rendered, [2]);
});

test('cancelling scheduled frame work resolves callers without rendering', async () => {
  const callbacks = new Map();
  const frame = new LatestFrame({
    requestFrame: (callback) => {
      callbacks.set(1, callback);
      return 1;
    },
    cancelFrame: (id) => callbacks.delete(id),
  });
  let rendered = false;
  const scheduled = frame.schedule(() => {
    rendered = true;
  });

  frame.cancel();
  await scheduled;

  assert.equal(rendered, false);
  assert.equal(callbacks.size, 0);
});
