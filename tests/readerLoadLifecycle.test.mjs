import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runReaderBookOpen,
} from '../src/lib/readerLoadLifecycle.ts';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const archivePrepared = (destroy) => ({
  book: {
    id: 'archive-id',
    name: 'archive.zip',
    mimeType: 'application/zip',
  },
  format: 'archive',
  source: {
    sections: [],
    resolveHref: () => ({ index: 0 }),
    destroy,
  },
  cacheContent: new Blob(),
});

test('destroys a prepared archive and skips open after cancellation during prepare', async () => {
  const controller = new AbortController();
  const preparation = deferred();
  let destroyCount = 0;
  let openCount = 0;
  let commitCount = 0;

  const task = runReaderBookOpen({
    signal: controller.signal,
    prepare: () => preparation.promise,
    open: async () => {
      openCount += 1;
    },
    commit: () => {
      commitCount += 1;
    },
  });

  controller.abort();
  preparation.resolve(archivePrepared(() => {
    destroyCount += 1;
  }));

  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(destroyCount, 1);
  assert.equal(openCount, 0);
  assert.equal(commitCount, 0);
});

test('destroys an archive immediately when cancellation happens during open', async () => {
  const controller = new AbortController();
  const opening = deferred();
  let destroyCount = 0;
  let commitCount = 0;

  const task = runReaderBookOpen({
    signal: controller.signal,
    prepare: async () => archivePrepared(() => {
      destroyCount += 1;
    }),
    open: () => opening.promise,
    commit: () => {
      commitCount += 1;
    },
  });

  await Promise.resolve();
  controller.abort();
  assert.equal(destroyCount, 1);
  opening.resolve();

  await assert.rejects(task, { name: 'AbortError' });
  assert.equal(destroyCount, 1);
  assert.equal(commitCount, 0);
});

test('releases archive ownership after a successful open', async () => {
  const controller = new AbortController();
  let destroyCount = 0;
  let commitCount = 0;

  await runReaderBookOpen({
    signal: controller.signal,
    prepare: async () => archivePrepared(() => {
      destroyCount += 1;
    }),
    open: async () => {},
    commit: () => {
      commitCount += 1;
    },
  });

  controller.abort();
  assert.equal(destroyCount, 0);
  assert.equal(commitCount, 1);
});

test('destroys archive ownership when open fails', async () => {
  let destroyCount = 0;

  await assert.rejects(
    runReaderBookOpen({
      signal: new AbortController().signal,
      prepare: async () => archivePrepared(() => {
        destroyCount += 1;
      }),
      open: async () => {
        throw new Error('open failed');
      },
      commit: () => {},
    }),
    /open failed/,
  );

  assert.equal(destroyCount, 1);
});
