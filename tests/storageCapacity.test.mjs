import test from 'node:test';
import assert from 'node:assert/strict';

import { hasEnoughStorageForWrite } from '../src/lib/storageCapacity.ts';

test('checks only the additional local bytes and preserves storage headroom', () => {
  assert.equal(hasEnoughStorageForWrite({}, 500), true);
  assert.equal(hasEnoughStorageForWrite({ usage: 100, quota: 1000 }, 0), true);
  assert.equal(hasEnoughStorageForWrite({ usage: 100, quota: 1000 }, 850), true);
  assert.equal(hasEnoughStorageForWrite({ usage: 100, quota: 1000 }, 851), false);
  assert.equal(hasEnoughStorageForWrite({ usage: 990, quota: 1000 }, 1), false);
});
