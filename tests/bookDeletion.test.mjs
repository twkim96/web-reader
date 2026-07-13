import test from 'node:test';
import assert from 'node:assert/strict';

import { deleteBookInSafeOrder } from '../src/lib/bookDeletion.ts';

test('does not reset progress when Drive deletion fails', async () => {
  const calls = [];
  await assert.rejects(deleteBookInSafeOrder({
    deleteDrive: async () => {
      calls.push('drive');
      throw new Error('drive permission denied');
    },
    resetProgress: async () => {
      calls.push('reset');
      return true;
    },
    removeLocalContent: async () => { calls.push('local'); },
  }), /permission denied/);
  assert.deepEqual(calls, ['drive']);
});

test('keeps local content when progress reset fails after Drive deletion', async () => {
  const calls = [];
  assert.equal(await deleteBookInSafeOrder({
    deleteDrive: async () => { calls.push('drive'); },
    resetProgress: async () => {
      calls.push('reset');
      return false;
    },
    removeLocalContent: async () => { calls.push('local'); },
  }), false);
  assert.deepEqual(calls, ['drive', 'reset']);
});

test('removes local content only after the preceding deletion stages succeed', async () => {
  const calls = [];
  assert.equal(await deleteBookInSafeOrder({
    deleteDrive: async () => { calls.push('drive'); },
    resetProgress: async () => {
      calls.push('reset');
      return true;
    },
    removeLocalContent: async () => { calls.push('local'); },
  }), true);
  assert.deepEqual(calls, ['drive', 'reset', 'local']);
});
