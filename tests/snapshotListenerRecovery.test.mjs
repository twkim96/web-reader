import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SnapshotListenerRecovery,
  classifySnapshotListenerError,
  getSnapshotRetryDelayMs,
} from '../src/lib/snapshotListenerRecovery.ts';

const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

const createHarness = (overrides = {}) => {
  let nextTimerId = 1;
  const timers = new Map();
  const subscriptions = [];
  const health = [];
  const errors = [];
  const controller = new SnapshotListenerRecovery({
    subscribe(onSnapshot, onError) {
      const subscription = { onSnapshot, onError, disposed: false };
      subscriptions.push(subscription);
      return () => { subscription.disposed = true; };
    },
    onSnapshot: overrides.onSnapshot ?? (() => undefined),
    isAuthoritative: (snapshot) => snapshot.authoritative,
    onHealthChange: (next) => health.push(next),
    onError: (error) => errors.push(error),
    canRetry: overrides.canRetry ?? (() => true),
    setTimer(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    now: overrides.now,
  });
  return {
    controller,
    subscriptions,
    timers,
    health,
    errors,
    takeTimer() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      return timer;
    },
  };
};

test('re-subscribes after a terminal error and clears health on authoritative data', async () => {
  const harness = createHarness();
  harness.controller.start();
  assert.equal(harness.subscriptions.length, 1);

  harness.subscriptions[0].onError({ code: 'firestore/permission-denied' });
  assert.equal(harness.subscriptions[0].disposed, true);
  assert.deepEqual(harness.health, ['healthy']);
  const retry = harness.takeTimer();
  assert.equal(retry.delay, 1_000);
  retry.callback();
  assert.equal(harness.subscriptions.length, 2);
  harness.subscriptions[1].onSnapshot({ authoritative: false });
  await flushTasks();
  assert.deepEqual(harness.health, ['healthy']);
  harness.subscriptions[1].onSnapshot({ authoritative: true });
  await flushTasks();
  assert.deepEqual(harness.health, ['healthy']);
  assert.equal(harness.timers.size, 0);
});

test('tracks authoritative freshness and can force a healthy listener restart', async () => {
  let now = 100;
  const harness = createHarness({ now: () => now });
  harness.controller.start();
  assert.deepEqual(harness.controller.getFreshness(), {
    lastAttachedAt: 100,
    lastRestartAt: 0,
    lastAuthoritativeAt: 0,
  });

  harness.subscriptions[0].onSnapshot({ authoritative: false });
  await flushTasks();
  assert.equal(harness.controller.getLastAuthoritativeSnapshotAt(), 0);

  harness.subscriptions[0].onSnapshot({ authoritative: true });
  await flushTasks();
  assert.equal(harness.controller.getLastAuthoritativeSnapshotAt(), 100);

  now = 5_250;
  assert.equal(harness.controller.forceRestart(), true);
  assert.equal(harness.subscriptions[0].disposed, true);
  assert.equal(harness.subscriptions.length, 2);
  harness.subscriptions[1].onSnapshot({ authoritative: true });
  await flushTasks();
  assert.equal(harness.controller.getLastAuthoritativeSnapshotAt(), 5_250);
});

test('restarts a healthy listener that never receives an authoritative snapshot and cools down repeats', async () => {
  let now = 1_000;
  const harness = createHarness({ now: () => now });
  harness.controller.start();
  harness.subscriptions[0].onSnapshot({ authoritative: false });
  await flushTasks();

  now = 16_100;
  assert.equal(harness.controller.reconcile({ staleAfterMs: 15_000, now }), true);
  assert.equal(harness.subscriptions.length, 2);
  assert.equal(harness.subscriptions[0].disposed, true);

  now = 17_000;
  assert.equal(harness.controller.reconcile({ force: true, now }), false);
  assert.equal(harness.subscriptions.length, 2);

  now = 21_200;
  assert.equal(harness.controller.reconcile({ force: true, now }), true);
  assert.equal(harness.subscriptions.length, 3);
});

test('does not force restart while retry is disallowed', () => {
  let canRetry = false;
  const harness = createHarness({ canRetry: () => canRetry });
  harness.controller.start();
  assert.equal(harness.controller.forceRestart(), false);
  assert.equal(harness.subscriptions.length, 1);
  canRetry = true;
  assert.equal(harness.controller.forceRestart(), true);
  assert.equal(harness.subscriptions.length, 2);
});

test('surfaces a recoverable listener error only when the retry also fails', () => {
  const harness = createHarness();
  harness.controller.start();
  harness.subscriptions[0].onError({ code: 'unavailable' });
  assert.deepEqual(harness.health, ['healthy']);

  const retry = harness.takeTimer();
  assert.equal(retry.delay, 1_000);
  retry.callback();
  harness.subscriptions[1].onError({ code: 'unavailable' });
  assert.deepEqual(harness.health, ['healthy', 'retrying-receive']);
  assert.equal(harness.takeTimer().delay, 5_000);
});

test('ignores callbacks from an old generation and disposes the active subscription', () => {
  const harness = createHarness();
  harness.controller.start();
  harness.subscriptions[0].onError({ code: 'unavailable' });
  harness.controller.retryNow();
  assert.equal(harness.subscriptions.length, 2);

  harness.subscriptions[0].onError({ code: 'permission-denied' });
  assert.deepEqual(harness.health, ['healthy']);
  harness.controller.dispose();
  assert.equal(harness.subscriptions[1].disposed, true);
  assert.equal(harness.timers.size, 0);
});

test('does not loop on schema failures and caps retry delay', () => {
  const harness = createHarness();
  harness.controller.start();
  harness.subscriptions[0].onError({ code: 'failed-precondition' });
  assert.deepEqual(harness.health, ['healthy', 'blocked-schema']);
  assert.equal(harness.timers.size, 0);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 99].map(getSnapshotRetryDelayMs),
    [1_000, 5_000, 15_000, 30_000, 60_000, 60_000],
  );
  assert.equal(classifySnapshotListenerError({ code: 'unauthenticated' }), 'paused-auth');
});

test('re-subscribes when asynchronous snapshot processing fails', async () => {
  let shouldFail = true;
  const harness = createHarness({
    onSnapshot: async () => {
      if (shouldFail) throw Object.assign(new Error('IndexedDB failed'), { code: 'unavailable' });
    },
  });
  harness.controller.start();
  harness.subscriptions[0].onSnapshot({ authoritative: true });
  await flushTasks();
  assert.deepEqual(harness.health, ['healthy']);
  assert.equal(harness.subscriptions[0].disposed, true);

  shouldFail = false;
  harness.takeTimer().callback();
  harness.subscriptions[1].onSnapshot({ authoritative: true });
  await flushTasks();
  assert.deepEqual(harness.health, ['healthy']);
});

test('drops snapshots queued behind a failed subscription generation', async () => {
  const calls = [];
  const harness = createHarness({
    onSnapshot: async (snapshot) => {
      calls.push(snapshot.id);
      if (snapshot.id === 'first') {
        throw Object.assign(new Error('processing failed'), { code: 'unavailable' });
      }
    },
  });
  harness.controller.start();
  harness.subscriptions[0].onSnapshot({ id: 'first', authoritative: true });
  harness.subscriptions[0].onSnapshot({ id: 'stale-queued', authoritative: true });
  await flushTasks();
  assert.deepEqual(calls, ['first']);

  harness.takeTimer().callback();
  harness.subscriptions[1].onSnapshot({ id: 'fresh', authoritative: true });
  await flushTasks();
  assert.deepEqual(calls, ['first', 'fresh']);
});
