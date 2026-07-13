import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLegacyDriveTokenArtifacts,
  DriveTokenMemory,
  DRIVE_TOKEN_SESSION_KEY,
  hasRestorableDriveTokenSession,
} from '../src/lib/driveTokenMemory.ts';

const fakeStorage = () => {
  const removed = [];
  return {
    removed,
    removeItem(key) {
      removed.push(key);
    },
  };
};

test('clears only the exact legacy Drive token keys from both web storages', () => {
  const local = fakeStorage();
  const session = fakeStorage();
  clearLegacyDriveTokenArtifacts(local, session);
  const expected = ['google_drive_token', 'google_drive_token_expiry'];
  assert.deepEqual(local.removed, expected);
  assert.deepEqual(session.removed, expected);
});

test('snapshots and restores a short-lived Drive session with a safety margin', () => {
  const memory = new DriveTokenMemory();
  assert.equal(memory.save('secret-token', 120, 1_000, () => 'session-1'), 'session-1');
  assert.equal(memory.getToken(), 'secret-token');
  assert.equal(memory.getSessionId(), 'session-1');
  assert.equal(memory.isValid(90_999), true);
  assert.equal(memory.isValid(91_000), false);
  const snapshot = memory.snapshot();
  const restored = new DriveTokenMemory();
  assert.equal(restored.restore(snapshot, 90_999), true);
  assert.equal(restored.getToken(), 'secret-token');
  assert.equal(restored.getSessionId(), 'session-1');
  assert.equal(restored.restore(snapshot, 91_000), false);
  assert.equal(restored.getToken(), null);
  memory.clear();
  assert.equal(memory.getToken(), null);
  assert.equal(memory.getSessionId(), null);
});

test('rejects malformed persisted Drive sessions', () => {
  const memory = new DriveTokenMemory();
  assert.equal(memory.restore({ token: 'secret', expiresAt: 'later', sessionId: 's' }, 1), false);
  assert.equal(memory.restore({ token: '', expiresAt: 100, sessionId: 's' }, 1), false);
  assert.equal(memory.restore({ token: 'secret', expiresAt: 100, sessionId: '' }, 1), false);
});

test('detects only an unexpired stored Drive session for bootstrap gating', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null };
  values.set(DRIVE_TOKEN_SESSION_KEY, JSON.stringify({
    token: 'secret',
    expiresAt: 100,
    sessionId: 'session-1',
  }));
  assert.equal(hasRestorableDriveTokenSession(storage, 99), true);
  assert.equal(hasRestorableDriveTokenSession(storage, 100), false);
});
