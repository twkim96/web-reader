import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRetryablePreparation,
  FOLIATE_ENTRY_URL,
  FOLIATE_RUNTIME_CACHE_NAME,
  FOLIATE_RUNTIME_REVISION,
  FOLIATE_RUNTIME_VERSION,
} from '../src/lib/foliateRuntimeCache.ts';

test('retries Foliate runtime preparation after a transient failure', async () => {
  let attempts = 0;
  const prepare = createRetryablePreparation(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient Cache API failure');
  });

  await assert.rejects(prepare(), /transient Cache API failure/);
  await prepare();
  assert.equal(attempts, 2);
});

test('shares one in-flight Foliate runtime preparation', async () => {
  let attempts = 0;
  let finish;
  const prepare = createRetryablePreparation(() => {
    attempts += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  const first = prepare();
  const second = prepare();
  assert.equal(first, second);
  assert.equal(attempts, 0);
  await Promise.resolve();
  assert.equal(attempts, 1);
  finish();
  await Promise.all([first, second]);
});

test('keeps the release cache version while revising the Foliate entry separately', () => {
  assert.equal(FOLIATE_RUNTIME_VERSION, '1.8.36');
  assert.equal(FOLIATE_RUNTIME_REVISION, '1.8.36-development');
  assert.equal(FOLIATE_RUNTIME_CACHE_NAME, 'pc-reader-v1.8.36-development');
  assert.equal(FOLIATE_ENTRY_URL, '/foliate-js/view.js?v=1.8.36-development');
});
