import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SevenZipWorkerClient,
} from '../src/lib/sevenZipImages.ts';
import { ArchiveImageError } from '../src/lib/archiveImageBook.ts';

class FakeWorker {
  listeners = new Map();
  messages = [];
  terminated = false;
  postError = null;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  postMessage(message) {
    if (this.postError) throw this.postError;
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, data) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(type === 'message' ? { data } : {});
    }
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('terminates the Worker when archive initialization is cancelled', async () => {
  const worker = new FakeWorker();
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 1000 });
  const controller = new AbortController();

  const initialization = client.initialize(new Blob(['archive']), controller.signal);
  assert.equal(worker.messages.length, 1);
  assert.equal(worker.messages[0].type, 'init');

  controller.abort();

  await assert.rejects(initialization, { name: 'AbortError' });
  assert.equal(worker.terminated, true);
});

test('sends one active extraction and only the latest queued page to the Worker', async () => {
  const worker = new FakeWorker();
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 1000 });

  const first = client.extract('1.jpg', 'image/jpeg', 1);
  const second = client.extract('2.jpg', 'image/jpeg', 1);
  const latest = client.extract('1.jpg', 'image/jpeg', 1);

  await assert.rejects(second, { name: 'AbortError' });
  assert.deepEqual(worker.messages.map(({ entryName }) => entryName), ['1.jpg']);

  worker.emit('message', {
    id: worker.messages[0].id,
    ok: true,
    blob: new Blob(['1']),
  });
  assert.equal((await first).size, 1);
  await flush();

  assert.deepEqual(
    worker.messages.map(({ entryName }) => entryName),
    ['1.jpg', '1.jpg'],
  );
  worker.emit('message', {
    id: worker.messages[1].id,
    ok: true,
    blob: new Blob(['2']),
  });
  assert.equal((await latest).size, 1);
  client.close();
});

test('discards an active extraction result after caller cancellation', async () => {
  const worker = new FakeWorker();
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 1000 });
  const controller = new AbortController();

  const stale = client.extract('stale.jpg', 'image/jpeg', 1, controller.signal);
  controller.abort();
  await assert.rejects(stale, { name: 'AbortError' });

  const latest = client.extract('latest.jpg', 'image/jpeg', 1);
  assert.equal(worker.messages.length, 1);
  worker.emit('message', {
    id: worker.messages[0].id,
    ok: true,
    blob: new Blob(['s']),
  });
  await flush();

  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].entryName, 'latest.jpg');
  worker.emit('message', {
    id: worker.messages[1].id,
    ok: true,
    blob: new Blob(['l']),
  });
  assert.equal((await latest).size, 1);
  client.close();
});

test('terminates the Worker and rejects queued extraction after timeout', async () => {
  const worker = new FakeWorker();
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 5 });

  const active = client.extract('slow.jpg', 'image/jpeg', 1);
  const pending = client.extract('latest.jpg', 'image/jpeg', 1);

  await assert.rejects(
    active,
    (error) => error instanceof ArchiveImageError && error.code === 'timeout',
  );
  await assert.rejects(
    pending,
    (error) => error instanceof ArchiveImageError && error.code === 'timeout',
  );
  assert.equal(worker.terminated, true);
  assert.equal(worker.messages.length, 1);
});

test('rejects active and queued extraction when the Worker fails', async () => {
  const worker = new FakeWorker();
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 1000 });

  const active = client.extract('active.jpg', 'image/jpeg', 1);
  const pending = client.extract('pending.jpg', 'image/jpeg', 1);
  worker.emit('error');

  await assert.rejects(active, ArchiveImageError);
  await assert.rejects(pending, ArchiveImageError);
  assert.equal(worker.terminated, true);
  assert.equal(worker.messages.length, 1);
});

test('terminates the Worker when posting an extraction request fails', async () => {
  const worker = new FakeWorker();
  worker.postError = new DOMException('clone failed', 'DataCloneError');
  const client = new SevenZipWorkerClient({ worker, extractTimeoutMs: 1000 });

  await assert.rejects(client.extract('page.jpg', 'image/jpeg', 1), (error) => (
    error instanceof ArchiveImageError
    && /요청을 보내지 못했습니다/.test(error.message)
  ));
  assert.equal(worker.terminated, true);
  assert.equal(worker.messages.length, 0);
});
