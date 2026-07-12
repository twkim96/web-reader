import test from 'node:test';
import assert from 'node:assert/strict';

import { decideProgressTransaction } from '../src/lib/progressSyncTransaction.ts';

const event = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  eventId: 'event-1',
  target: { kind: 'progress', bookId: 'book-1' },
  targetKey: 'progress:book-1',
  operation: 'progress.set',
  payload: { cfi: 'cfi', anchorCfi: null, progressPercent: 10 },
  deviceId: 'device-1',
  sessionId: 'session-1',
  sequence: 1,
  baseRevision: 0,
  occurredAtClient: 1,
  status: 'in_flight',
  attempts: 1,
  nextAttemptAt: 1,
  lastErrorCode: null,
  claimedByTabId: 'tab-1',
  claimedLeaseEpoch: 1,
  ...overrides,
});

const head = (overrides = {}) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  revision: 1,
  acceptedEventId: 'event-1',
  operation: 'set',
  position: { cfi: 'cfi', anchorCfi: null, progressPercent: 10 },
  acceptedDeviceId: 'device-1',
  occurredAtClient: 1,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});

const receipt = (overrides = {}) => ({
  schemaVersion: 2,
  eventId: 'event-1',
  targetKind: 'progress',
  bookId: 'book-1',
  bookmarkId: null,
  targetKey: 'progress:book-1',
  revision: 1,
  createdAtServer: {},
  ...overrides,
});

test('applies a new event at exactly base revision plus one', () => {
  const result = decideProgressTransaction({
    event: event(),
    storedHead: undefined,
    storedReceipt: undefined,
    serverTime: 'server-time',
  });
  assert.equal(result.status, 'apply');
  assert.equal(result.head.revision, 1);
  assert.equal(result.receipt.revision, 1);
  assert.equal(result.head.updatedAtServer, 'server-time');
});

test('returns conflict without rewriting an old event base revision', () => {
  const remote = head({ acceptedEventId: 'other', revision: 1 });
  const stale = event({ baseRevision: 0 });
  const result = decideProgressTransaction({
    event: stale,
    storedHead: remote,
    storedReceipt: undefined,
    serverTime: {},
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.remoteHead, remote);
  assert.equal(stale.baseRevision, 0);
});

test('treats a matching immutable receipt as already applied', () => {
  const result = decideProgressTransaction({
    event: event(),
    storedHead: head(),
    storedReceipt: receipt(),
    serverTime: {},
  });
  assert.equal(result.status, 'already_applied');
  assert.equal(result.head.revision, 1);
});

test('rejects an inconsistent receipt/head pair', () => {
  assert.throws(() => decideProgressTransaction({
    event: event(),
    storedHead: head({ acceptedEventId: 'other' }),
    storedReceipt: receipt(),
    serverTime: {},
  }));
});

test('creates a reset tombstone instead of deleting the head', () => {
  const result = decideProgressTransaction({
    event: event({
      eventId: 'event-2',
      operation: 'progress.reset',
      payload: null,
      baseRevision: 1,
    }),
    storedHead: head(),
    storedReceipt: undefined,
    serverTime: 'server-time',
  });
  assert.equal(result.status, 'apply');
  assert.equal(result.head.operation, 'reset');
  assert.equal(result.head.position, null);
  assert.equal(result.head.deletedAtServer, 'server-time');
});
