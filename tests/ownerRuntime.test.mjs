import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFirebaseOwnerKey, makeOwnerKey } from '../src/lib/ownerIdentity.ts';
import { OwnerRuntime, runForOwnerSnapshot } from '../src/lib/ownerRuntime.ts';

const ownerA = makeOwnerKey(makeFirebaseOwnerKey('a'), 'library:local');
const ownerB = makeOwnerKey(makeFirebaseOwnerKey('b'), 'library:local');

test('owner activation invalidates old async snapshots before switching', async () => {
  const runtime = new OwnerRuntime();
  const a = runtime.activate(ownerA);
  let disposed = false;
  runtime.registerDisposer(() => { disposed = true; });

  const lateA = Promise.resolve('late-a').then((value) => (
    runtime.isCurrent(a) ? value : 'discarded'
  ));
  const b = runtime.activate(ownerB);

  assert.equal(disposed, true);
  assert.equal(runtime.isCurrent(a), false);
  assert.equal(runtime.isCurrent(b), true);
  assert.equal(await lateA, 'discarded');
});

test('reactivating the same owner preserves its generation', () => {
  const runtime = new OwnerRuntime();
  const first = runtime.activate(ownerA);
  const second = runtime.activate(ownerA);
  assert.equal(first, second);
  assert.equal(runtime.isCurrent(first), true);
  runtime.clear();
  assert.equal(runtime.isCurrent(first), false);
});

test('logout and login with the same owner key invalidates stale continuations', () => {
  const runtime = new OwnerRuntime();
  const stale = runtime.activate(ownerA);
  runtime.clear();
  const current = runtime.activate(ownerA);

  assert.equal(stale.ownerKey, current.ownerKey);
  assert.notEqual(stale.generation, current.generation);
  assert.equal(runtime.isCurrent(stale), false);
  assert.equal(runtime.isCurrent(current), true);
});

test('drops a completed async result after same-key logout and login', async () => {
  const runtime = new OwnerRuntime();
  const stale = runtime.activate(ownerA);
  let finish;
  const operation = runForOwnerSnapshot(
    runtime,
    stale,
    () => new Promise((resolve) => { finish = resolve; }),
  );

  runtime.clear();
  runtime.activate(ownerA);
  finish('stale transaction result');

  assert.equal(await operation, null);
});
