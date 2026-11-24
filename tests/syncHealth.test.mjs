import test from 'node:test';
import assert from 'node:assert/strict';

import { getPausedWriteSyncState, isAuthSyncErrorCode, mergeSyncHealth } from '../src/lib/syncHealth.ts';

test('merges send and receive health by actionable severity', () => {
  assert.equal(mergeSyncHealth('healthy', 'retrying-receive'), 'retrying-receive');
  assert.equal(mergeSyncHealth('paused-auth', 'retrying-receive'), 'paused-auth');
  assert.equal(mergeSyncHealth('blocked-permission', 'paused-auth'), 'blocked-permission');
  assert.equal(mergeSyncHealth('blocked-schema', 'blocked-permission'), 'blocked-schema');
});

test('classifies every resumable Firebase token expiry as authentication health', () => {
  assert.equal(isAuthSyncErrorCode('unauthenticated'), true);
  assert.equal(isAuthSyncErrorCode('auth/user-token-expired'), true);
  assert.equal(isAuthSyncErrorCode('auth/id-token-expired'), true);
  assert.equal(isAuthSyncErrorCode('permission-denied'), false);
});

test('a token failure does not hide the paused format or permission failure of a different write', () => {
  assert.deepEqual(getPausedWriteSyncState(['auth/user-token-expired', 'invalid-argument']), { health: 'paused-auth', recoveryAvailable: true });
  assert.deepEqual(getPausedWriteSyncState(['permission-denied', 'unauthenticated']), { health: 'paused-auth', recoveryAvailable: true });
  assert.deepEqual(getPausedWriteSyncState(['auth/id-token-expired']), { health: 'paused-auth', recoveryAvailable: false });
});
