import test from 'node:test';
import assert from 'node:assert/strict';

import { decideBookmarkTransaction } from '../src/lib/bookmarkSyncTransaction.ts';

const payload = {
  bookmarkId: 'mark-1',
  cfi: 'cfi',
  name: 'mark',
  color: '#fff',
  progressPercent: 10,
  createdAtClient: 1,
  updatedAtClient: 2,
};
const event = (overrides = {}) => ({
  ownerKey: 'firebase:a|library:local',
  eventId: 'event-1',
  target: { kind: 'bookmark', bookId: 'book-1', bookmarkId: 'mark-1' },
  targetKey: 'bookmark:book-1:mark-1',
  operation: 'bookmark.upsert',
  payload,
  deviceId: 'device-1',
  sessionId: 'session-1',
  sequence: 1,
  baseRevision: 0,
  occurredAtClient: 2,
  status: 'in_flight',
  attempts: 1,
  nextAttemptAt: 2,
  lastErrorCode: null,
  claimedByTabId: 'tab-1',
  claimedLeaseEpoch: 1,
  ...overrides,
});
const head = (overrides = {}) => ({
  schemaVersion: 2,
  bookId: 'book-1',
  bookmarkId: 'mark-1',
  revision: 1,
  acceptedEventId: 'event-1',
  operation: 'upsert',
  bookmark: payload,
  acceptedDeviceId: 'device-1',
  occurredAtClient: 2,
  updatedAtServer: {},
  deletedAtServer: null,
  ...overrides,
});
const receipt = {
  schemaVersion: 2,
  eventId: 'event-1',
  targetKind: 'bookmark',
  bookId: 'book-1',
  bookmarkId: 'mark-1',
  targetKey: 'bookmark:book-1:mark-1',
  revision: 1,
  createdAtServer: {},
};

test('applies bookmark upsert and matching receipt at revision one', () => {
  const result = decideBookmarkTransaction({
    event: event(), storedHead: undefined, storedReceipt: undefined, serverTime: 'server',
  });
  assert.equal(result.status, 'apply');
  assert.equal(result.head.revision, 1);
  assert.equal(result.head.bookmark.bookmarkId, 'mark-1');
  assert.equal(result.head.acceptedSessionId, 'session-1');
});

test('turns bookmark deletion into a tombstone', () => {
  const result = decideBookmarkTransaction({
    event: event({
      eventId: 'event-2',
      operation: 'bookmark.delete',
      payload: null,
      baseRevision: 1,
    }),
    storedHead: head(),
    storedReceipt: undefined,
    serverTime: 'server',
  });
  assert.equal(result.status, 'apply');
  assert.equal(result.head.operation, 'delete');
  assert.equal(result.head.bookmark, null);
  assert.equal(result.head.deletedAtServer, 'server');
});

test('preserves stale bookmark edit as conflict', () => {
  const result = decideBookmarkTransaction({
    event: event({ baseRevision: 0 }),
    storedHead: head({ acceptedEventId: 'other', revision: 2 }),
    storedReceipt: undefined,
    serverTime: {},
  });
  assert.equal(result.status, 'conflict');
  assert.equal(result.remoteHead.revision, 2);
});

test('uses an immutable receipt to avoid duplicate bookmark revision', () => {
  const result = decideBookmarkTransaction({
    event: event(), storedHead: head(), storedReceipt: receipt, serverTime: {},
  });
  assert.equal(result.status, 'already_applied');
});

test('accepts an older bookmark receipt after a later upsert advances the head', () => {
  const result = decideBookmarkTransaction({
    event: event(),
    storedHead: head({ revision: 2, acceptedEventId: 'event-2' }),
    storedReceipt: receipt,
    serverTime: {},
  });
  assert.equal(result.status, 'already_applied');
  assert.equal(result.head.revision, 2);
  assert.equal(result.receipt.revision, 1);
});

test('accepts an older bookmark receipt after a tombstone advances the head', () => {
  const result = decideBookmarkTransaction({
    event: event(),
    storedHead: head({
      revision: 2,
      acceptedEventId: 'event-2',
      operation: 'delete',
      bookmark: null,
      deletedAtServer: {},
    }),
    storedReceipt: receipt,
    serverTime: {},
  });
  assert.equal(result.status, 'already_applied');
  assert.equal(result.head.operation, 'delete');
});
