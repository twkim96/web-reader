import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookmarkTargetKeyV2,
  getFirebaseSyncHistoryPath,
  isBookmarkHeadV2,
  isEventReceiptV2,
  isProgressHeadV2,
  parseProgressHeadV2,
  progressTargetKeyV2,
} from '../src/lib/progressV2Schema.ts';
import { isExactSyncSessionEcho } from '../src/lib/syncSession.ts';

const timestamp = { seconds: 1, nanoseconds: 0 };
const progress = {
  schemaVersion: 2,
  bookId: 'book-1',
  revision: 1,
  acceptedEventId: 'event-1',
  operation: 'set',
  position: { cfi: 'epubcfi(/6/2)', anchorCfi: null, progressPercent: 25 },
  acceptedDeviceId: 'device-1',
  occurredAtClient: 10,
  updatedAtServer: timestamp,
  deletedAtServer: null,
};

test('builds only the Firebase account canonical history path', () => {
  assert.equal(
    getFirebaseSyncHistoryPath('app', 'user'),
    'artifacts/app/users/user/libraries/local/readingHistoryV2',
  );
  assert.equal(progressTargetKeyV2('b'), 'progress:b');
  assert.equal(bookmarkTargetKeyV2('b', 'm'), 'bookmark:b:m');
});

test('accepts exact progress schema and set/reset invariants', () => {
  assert.equal(isProgressHeadV2(progress), true);
  assert.equal(isProgressHeadV2({ ...progress, unknown: true }), false);
  assert.equal(isProgressHeadV2({ ...progress, revision: 0 }), false);
  assert.equal(isProgressHeadV2({
    ...progress,
    position: { ...progress.position, progressPercent: 101 },
  }), false);
  assert.equal(isProgressHeadV2({
    ...progress,
    operation: 'reset',
    position: null,
    deletedAtServer: timestamp,
  }), true);
  assert.throws(() => parseProgressHeadV2({ ...progress, operation: 'reset' }));
  assert.equal(isProgressHeadV2({ ...progress, acceptedSessionId: 'session-1' }), true);
  assert.equal(isProgressHeadV2({ ...progress, acceptedSessionId: '' }), false);
});

test('treats only the exact tab session as a local echo', () => {
  assert.equal(isExactSyncSessionEcho('session-a', 'session-a'), true);
  assert.equal(isExactSyncSessionEcho('session-b', 'session-a'), false);
  assert.equal(isExactSyncSessionEcho(undefined, 'session-a'), false);
});

test('validates bookmark payload identity and tombstones', () => {
  const bookmark = {
    schemaVersion: 2,
    bookId: 'book-1',
    bookmarkId: 'mark-1',
    revision: 1,
    acceptedEventId: 'event-2',
    operation: 'upsert',
    bookmark: {
      bookmarkId: 'mark-1',
      cfi: 'epubcfi(/6/4)',
      name: 'mark',
      color: '#fff',
      progressPercent: 30,
      createdAtClient: 1,
      updatedAtClient: 2,
    },
    acceptedDeviceId: 'device-1',
    occurredAtClient: 2,
    updatedAtServer: timestamp,
    deletedAtServer: null,
  };
  assert.equal(isBookmarkHeadV2(bookmark), true);
  assert.equal(isBookmarkHeadV2({
    ...bookmark,
    bookmark: { ...bookmark.bookmark, bookmarkId: 'other' },
  }), false);
  assert.equal(isBookmarkHeadV2({
    ...bookmark,
    operation: 'delete',
    bookmark: null,
    deletedAtServer: timestamp,
  }), true);
});

test('receipt schema rejects unknown fields and invalid revisions', () => {
  const receipt = {
    schemaVersion: 2,
    eventId: 'event-1',
    targetKind: 'progress',
    bookId: 'book-1',
    bookmarkId: null,
    targetKey: 'progress:book-1',
    revision: 1,
    createdAtServer: timestamp,
  };
  assert.equal(isEventReceiptV2(receipt), true);
  assert.equal(isEventReceiptV2({ ...receipt, revision: 1.5 }), false);
  assert.equal(isEventReceiptV2({ ...receipt, payload: {} }), false);
});
