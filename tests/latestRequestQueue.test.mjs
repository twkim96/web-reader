import test from 'node:test';
import assert from 'node:assert/strict';

import { LatestRequestQueue } from '../src/lib/latestRequestQueue.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test('keeps one active request and only the latest pending request', async () => {
  const operations = new Map();
  const started = [];
  const queue = new LatestRequestQueue((value) => {
    started.push(value);
    const operation = deferred();
    operations.set(value, operation);
    return operation.promise;
  });

  const first = queue.request('next-1');
  const second = queue.request('next-2');
  const third = queue.request('previous');

  await assert.rejects(second, { name: 'AbortError' });
  assert.deepEqual(started, ['next-1']);

  operations.get('next-1').resolve('stale');
  assert.equal(await first, 'stale');
  await Promise.resolve();
  assert.deepEqual(started, ['next-1', 'previous']);

  operations.get('previous').resolve('latest');
  assert.equal(await third, 'latest');
});

test('rejects an active caller immediately but waits for its work before starting latest', async () => {
  const activeOperation = deferred();
  const started = [];
  const queue = new LatestRequestQueue(async (value) => {
    started.push(value);
    if (value === 'active') return activeOperation.promise;
    return value;
  });
  const controller = new AbortController();

  const active = queue.request('active', controller.signal);
  controller.abort();
  await assert.rejects(active, { name: 'AbortError' });

  const latest = queue.request('latest');
  assert.deepEqual(started, ['active']);
  activeOperation.resolve('discarded');
  assert.equal(await latest, 'latest');
  assert.deepEqual(started, ['active', 'latest']);
});

test('removes a pending request when its signal is cancelled', async () => {
  const activeOperation = deferred();
  const queue = new LatestRequestQueue((value) => (
    value === 'active' ? activeOperation.promise : Promise.resolve(value)
  ));
  const controller = new AbortController();

  const active = queue.request('active');
  const pending = queue.request('pending', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });

  activeOperation.resolve('active');
  assert.equal(await active, 'active');
});

test('rejects active and pending requests when the queue closes', async () => {
  const queue = new LatestRequestQueue(() => new Promise(() => {}));
  const active = queue.request('active');
  const pending = queue.request('pending');
  const failure = new Error('worker failed');

  queue.close(failure);

  await assert.rejects(active, /worker failed/);
  await assert.rejects(pending, /worker failed/);
  await assert.rejects(queue.request('late'), /worker failed/);
});
