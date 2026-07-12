import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearLegacyDriveTokenArtifacts,
  DriveTokenMemory,
  DriveTokenRequestSingleFlight,
  hasLegacyOAuthFragment,
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

test('keeps bearer token and expiry only in memory with a safety margin', () => {
  const memory = new DriveTokenMemory();
  assert.equal(memory.save('secret-token', 120, 1_000, () => 'session-1'), 'session-1');
  assert.equal(memory.getToken(), 'secret-token');
  assert.equal(memory.getSessionId(), 'session-1');
  assert.equal(memory.isValid(90_999), true);
  assert.equal(memory.isValid(91_000), false);
  memory.clear();
  assert.equal(memory.getToken(), null);
  assert.equal(memory.getSessionId(), null);
});

test('coalesces concurrent GIS token requests and permits a later retry', async () => {
  const requester = new DriveTokenRequestSingleFlight();
  let starts = 0;
  let release;
  const first = requester.run(() => {
    starts += 1;
    return new Promise((resolve) => { release = resolve; });
  });
  const concurrent = requester.run(async () => { starts += 1; });
  assert.equal(first, concurrent);
  await Promise.resolve();
  assert.equal(starts, 1);
  release();
  await first;
  await requester.run(async () => { starts += 1; });
  assert.equal(starts, 2);
});

test('recognizes only legacy OAuth result fragments that require removal', () => {
  assert.equal(hasLegacyOAuthFragment('#access_token=secret&state=x'), true);
  assert.equal(hasLegacyOAuthFragment('#error=access_denied'), true);
  assert.equal(hasLegacyOAuthFragment('#chapter-3'), false);
  assert.equal(hasLegacyOAuthFragment('#chapter-error=example'), false);
});
