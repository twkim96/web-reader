import test from 'node:test';
import assert from 'node:assert/strict';

import { makeFirebaseOwnerKey, makeOwnerKey } from '../src/lib/ownerIdentity.ts';
import { OwnerRuntime } from '../src/lib/ownerRuntime.ts';

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
