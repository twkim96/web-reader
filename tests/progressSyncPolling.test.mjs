import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVE_SYNC_POLL_DELAY_MS,
  IDLE_SYNC_POLL_DELAY_MS,
  runProgressSyncPoll,
} from '../src/lib/progressSyncPolling.ts';

test('a local polling error backs off and a later poll can recover', async () => {
  let calls = 0;
  const errors = [];
  const flush = async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary IndexedDB failure');
    return 'apply';
  };
  assert.equal(await runProgressSyncPoll(flush, (error) => errors.push(error)), IDLE_SYNC_POLL_DELAY_MS);
  assert.equal(await runProgressSyncPoll(flush, (error) => errors.push(error)), ACTIVE_SYNC_POLL_DELAY_MS);
  assert.equal(errors.length, 1);
});

test('a stale lease uses the active delay so receipt recovery is not held for 30 seconds', async () => {
  assert.equal(
    await runProgressSyncPoll(async () => 'stale_lease', () => undefined),
    ACTIVE_SYNC_POLL_DELAY_MS,
  );
});
