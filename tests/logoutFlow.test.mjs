import assert from 'node:assert/strict';
import test from 'node:test';

import { runLogoutFlow } from '../src/lib/logoutFlow.ts';

test('keeps local owner cleanup behind successful Firebase sign-out', async () => {
  const events = [];
  const result = await runLogoutFlow({
    prepareUi: () => events.push('prepare-ui'),
    signOut: async () => events.push('firebase-sign-out'),
    commitLocalCleanup: () => events.push('local-cleanup'),
    recoverUi: () => events.push('recover-ui'),
  });

  assert.equal(result, true);
  assert.deepEqual(events, ['prepare-ui', 'firebase-sign-out', 'local-cleanup']);
});

test('recovers the shelf without clearing local owner state when sign-out fails', async () => {
  const events = [];
  const failure = new Error('offline');
  let recoveredError;
  const result = await runLogoutFlow({
    prepareUi: () => events.push('prepare-ui'),
    signOut: async () => {
      events.push('firebase-sign-out');
      throw failure;
    },
    commitLocalCleanup: () => events.push('local-cleanup'),
    recoverUi: (error) => {
      recoveredError = error;
      events.push('recover-ui');
    },
  });

  assert.equal(result, false);
  assert.equal(recoveredError, failure);
  assert.deepEqual(events, ['prepare-ui', 'firebase-sign-out', 'recover-ui']);
});
