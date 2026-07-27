import test from 'node:test';
import assert from 'node:assert/strict';

import { isQuietStartupProgressConflict } from '../src/lib/syncConflictPolicy.ts';

const progressEvent = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  eventId: 'local-1',
  target: { kind: 'progress', bookId: 'book-1' },
  targetKey: 'progress:book-1',
  operation: 'progress.set',
  payload: { cfi: 'local-cfi', anchorCfi: null, progressPercent: 30 },
  deviceId: 'device-1',
  sessionId: 'previous-session',
  sequence: 1,
  baseRevision: 2,
  occurredAtClient: 10,
  status: 'conflict',
  attempts: 1,
  nextAttemptAt: null,
  lastErrorCode: null,
  claimedByTabId: null,
  claimedLeaseEpoch: null,
  claimToken: null,
  ...overrides,
});

const remoteHead = (overrides = {}) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  revision: 3,
  acceptedEventId: 'remote-3',
  operation: 'set',
  position: { cfi: 'remote-cfi', anchorCfi: null, progressPercent: 70 },
  acceptedDeviceId: 'device-2',
  acceptedSessionId: 'remote-session',
  occurredAtClient: 20,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});

const conflict = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  conflictId: 'local-1',
  targetKey: 'progress:book-1',
  state: 'open',
  event: progressEvent(),
  remoteHead: remoteHead(),
  latestLocalPosition: { cfi: 'local-cfi', anchorCfi: null, progressPercent: 30 },
  blockedEventIds: [],
  createdAt: 30,
  ...overrides,
});

const eligible = (target, overrides = {}) => isQuietStartupProgressConflict({
  conflict: target,
  activeBookId: 'book-1',
  currentSessionId: 'current-session',
  ...overrides,
});

test('quietly resolves only an older-session active-book position behind a valid remote head', () => {
  assert.equal(eligible(conflict()), true);
  assert.equal(eligible(conflict(), { activeBookId: 'book-2' }), false);
  assert.equal(eligible(conflict(), { currentSessionId: 'previous-session' }), false);
  assert.equal(eligible(conflict({
    remoteHead: remoteHead({ revision: 2 }),
  })), false);
  assert.equal(eligible(conflict({ blockedEventIds: ['later-local-event'] })), false);
  assert.equal(eligible(conflict({
    latestLocalPosition: { cfi: 'new-local-cfi', anchorCfi: null, progressPercent: 31 },
  })), false);
});

test('keeps destructive progress and bookmark conflicts user-visible', () => {
  assert.equal(eligible(conflict({
    event: progressEvent({ operation: 'progress.reset', payload: null }),
  })), false);
  assert.equal(eligible(conflict({
    remoteHead: remoteHead({ operation: 'reset', position: null }),
  })), false);
  assert.equal(eligible(conflict({ remoteHead: null })), false);
  assert.equal(eligible(conflict({
    event: {
      ...progressEvent(),
      target: { kind: 'bookmark', bookId: 'book-1', bookmarkId: 'mark-1' },
      targetKey: 'bookmark:book-1:mark-1',
      operation: 'bookmark.delete',
      payload: null,
    },
  })), false);
});
