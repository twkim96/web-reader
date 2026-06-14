import test from 'node:test';
import assert from 'node:assert/strict';

import { runSequentialBatch } from '../src/lib/sequentialBatch.ts';

test('refreshes once after a batch with multiple successful cloud changes', async () => {
  const refreshed = [];
  const processed = [];
  const controller = new AbortController();

  const result = await runSequentialBatch(
    ['a', 'b', 'c'],
    controller.signal,
    async (item) => {
      processed.push(item);
      return { refresh: true };
    },
    () => refreshed.push('refresh'),
  );

  assert.deepEqual(processed, ['a', 'b', 'c']);
  assert.deepEqual(refreshed, ['refresh']);
  assert.deepEqual(result, { processedCount: 3, refreshed: true });
});

test('stops before later files after authentication expiry', async () => {
  const processed = [];
  const controller = new AbortController();

  await runSequentialBatch(
    ['a', 'expired', 'never'],
    controller.signal,
    async (item) => {
      processed.push(item);
      return { refresh: item === 'a', stop: item === 'expired' };
    },
    () => {},
  );

  assert.deepEqual(processed, ['a', 'expired']);
});

test('does not start another file after cancellation and still refreshes completed work', async () => {
  const processed = [];
  let refreshCount = 0;
  const controller = new AbortController();

  await runSequentialBatch(
    ['a', 'b', 'never'],
    controller.signal,
    async (item) => {
      processed.push(item);
      if (item === 'b') controller.abort();
      return { refresh: item === 'a' };
    },
    () => {
      refreshCount += 1;
    },
  );

  assert.deepEqual(processed, ['a', 'b']);
  assert.equal(refreshCount, 1);
});

test('continues after a non-fatal file failure without refreshing it', async () => {
  const processed = [];
  let refreshCount = 0;
  const controller = new AbortController();

  const result = await runSequentialBatch(
    ['failed', 'saved'],
    controller.signal,
    async (item) => {
      processed.push(item);
      return { refresh: item === 'saved' };
    },
    () => {
      refreshCount += 1;
    },
  );

  assert.deepEqual(processed, ['failed', 'saved']);
  assert.equal(refreshCount, 1);
  assert.equal(result.processedCount, 2);
});
