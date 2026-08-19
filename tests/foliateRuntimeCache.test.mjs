import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearStaleFoliateRuntimeEntries,
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

const createCacheStorage = (entriesByCache) => {
  const stores = new Map(Object.entries(entriesByCache).map(([name, urls]) => [
    name,
    new Set(urls),
  ]));
  return {
    stores,
    async keys() {
      return [...stores.keys()];
    },
    async open(name) {
      const entries = stores.get(name) ?? new Set();
      stores.set(name, entries);
      return {
        async keys() {
          return [...entries].map((url) => new Request(url));
        },
        async delete(request) {
          return entries.delete(request.url);
        },
      };
    },
  };
};

test('keeps the release cache version while revising the Foliate entry separately', () => {
  assert.equal(FOLIATE_RUNTIME_VERSION, '1.8.25');
  assert.equal(FOLIATE_RUNTIME_REVISION, '1.8.22.1');
  assert.equal(FOLIATE_RUNTIME_CACHE_NAME, 'pc-reader-v1.8.25');
  assert.equal(FOLIATE_ENTRY_URL, '/foliate-js/view.js?v=1.8.22.1');
});

test('removes only Foliate entries from stale release caches', async () => {
  const origin = 'https://reader.test';
  const cacheStorage = createCacheStorage({
    'pc-reader-v1.8.0': [
      `${origin}/foliate-js/view.js`,
      `${origin}/foliate-js/paginator.js?old=1`,
      `${origin}/fonts/reader.woff2`,
    ],
    'pc-reader-v1.8.11': [
      `${origin}/foliate-js/view.js?v=1.8.11`,
      `${origin}/foliate-js/paginator.js?v=1.8.11.2`,
    ],
    'pc-reader-v1.8.12': [
      `${origin}/foliate-js/view.js?v=1.8.12`,
      `${origin}/foliate-js/view.js?v=1.8.12.1`,
      `${origin}/foliate-js/view.js?v=1.8.12.2`,
    ],
    'pc-reader-v1.8.13': [
      `${origin}/foliate-js/view.js?v=1.8.13`,
      `${origin}/foliate-js/view.js?v=1.8.13.1`,
    ],
    'pc-reader-v1.8.14': [
      `${origin}/foliate-js/view.js?v=1.8.14`,
      `${origin}/foliate-js/view.js?v=1.8.14.1`,
    ],
    'unrelated-cache': [
      `${origin}/foliate-js/view.js`,
    ],
  });

  assert.equal(await clearStaleFoliateRuntimeEntries(cacheStorage, origin), 11);
  assert.deepEqual([...cacheStorage.stores.get('pc-reader-v1.8.0')], [
    `${origin}/fonts/reader.woff2`,
  ]);
  assert.deepEqual([...cacheStorage.stores.get('pc-reader-v1.8.11')], []);
  assert.deepEqual([...cacheStorage.stores.get('pc-reader-v1.8.12')], []);
  assert.deepEqual([...cacheStorage.stores.get('pc-reader-v1.8.13')], []);
  assert.deepEqual([...cacheStorage.stores.get('pc-reader-v1.8.14')], []);
  assert.deepEqual([...cacheStorage.stores.get('unrelated-cache')], [
    `${origin}/foliate-js/view.js`,
  ]);
});
