import test from 'node:test';
import assert from 'node:assert/strict';

import { ProgressSyncPumpController } from '../src/lib/progressSyncPump.ts';

const createTimerHarness = () => {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    takeOnlyTimer() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      return timer;
    },
  };
};

test('coalesces a wake during a running pump into an immediate follow-up', async () => {
  const harness = createTimerHarness();
  let resolvePoll;
  const poll = new Promise((resolve) => { resolvePoll = resolve; });
  const controller = new ProgressSyncPumpController({
    poll: () => poll,
    refreshHealth: async () => undefined,
    reportHealthError: () => undefined,
    isOnline: () => true,
    isVisible: () => true,
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  controller.request();
  const running = harness.takeOnlyTimer().callback();
  controller.request();
  assert.equal(harness.timers.size, 0);
  resolvePoll(30_000);
  await running;
  assert.equal(harness.takeOnlyTimer().delay, 0);
  controller.dispose();
});

test('keeps fallback polling alive when health refresh fails', async () => {
  const harness = createTimerHarness();
  const errors = [];
  const controller = new ProgressSyncPumpController({
    poll: async () => 30_000,
    refreshHealth: async () => { throw new Error('temporary IDB failure'); },
    reportHealthError: (error) => errors.push(error),
    isOnline: () => true,
    isVisible: () => true,
    setTimer: harness.setTimer,
    clearTimer: harness.clearTimer,
  });

  controller.request();
  await harness.takeOnlyTimer().callback();
  assert.equal(errors.length, 1);
  assert.equal(harness.takeOnlyTimer().delay, 30_000);
  controller.dispose();
});
