import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRemoteBookmarkHeadChanges,
  mergeAccumulatedRemoteBookmarks,
} from '../src/lib/remoteBookmarkAccumulator.ts';

const head = (bookmarkId, revision = 1, operation = 'upsert') => ({
  schemaVersion: 2,
  bookId: 'book-1',
  bookmarkId,
  revision,
  acceptedEventId: `${bookmarkId}-${revision}`,
  operation,
  bookmark: operation === 'delete' ? null : {
    bookmarkId,
    cfi: `cfi-${bookmarkId}`,
    name: bookmarkId,
    color: '#fff',
    progressPercent: 10,
    createdAtClient: 1,
    updatedAtClient: revision,
  },
  acceptedDeviceId: 'other-device',
  occurredAtClient: revision,
  updatedAtServer: {},
  deletedAtServer: operation === 'delete' ? {} : null,
});

test('accumulates bookmarks across snapshots and applies a later tombstone', () => {
  let heads = applyRemoteBookmarkHeadChanges(new Map(), [
    { type: 'upsert', head: head('x') },
  ]);
  heads = applyRemoteBookmarkHeadChanges(heads, [
    { type: 'upsert', head: head('y') },
  ]);
  assert.deepEqual(
    mergeAccumulatedRemoteBookmarks([], heads).map(({ id }) => id).sort(),
    ['x', 'y'],
  );

  heads = applyRemoteBookmarkHeadChanges(heads, [
    { type: 'upsert', head: head('x', 2, 'delete') },
  ]);
  assert.deepEqual(
    mergeAccumulatedRemoteBookmarks([], heads).map(({ id }) => id),
    ['y'],
  );
});
