import test from 'node:test';
import assert from 'node:assert/strict';

import { diffManualBookmarks } from '../src/lib/bookmarkSyncPolicy.ts';

const bookmark = (id, overrides = {}) => ({
  id,
  type: 'manual',
  name: id,
  cfi: `cfi-${id}`,
  progressPercent: 10,
  createdAt: 1,
  color: '#fff',
  ...overrides,
});

test('creates independent upserts for concurrent manual bookmarks', () => {
  const changes = diffManualBookmarks([], [bookmark('a'), bookmark('b')], 10);
  assert.deepEqual(changes.map(({ bookmarkId }) => bookmarkId), ['a', 'b']);
  assert.ok(changes.every(({ operation }) => operation === 'bookmark.upsert'));
});

test('emits one upsert only when an existing bookmark changes', () => {
  const previous = [bookmark('a'), bookmark('b')];
  const next = [bookmark('a', { name: 'edited' }), bookmark('b')];
  const changes = diffManualBookmarks(previous, next, 10);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].bookmarkId, 'a');
  assert.equal(changes[0].payload.name, 'edited');
});

test('represents deletion as a tombstone event and ignores auto bookmarks', () => {
  const auto = bookmark('auto', { type: 'auto' });
  const changes = diffManualBookmarks([bookmark('a'), auto], [auto], 10);
  assert.deepEqual(changes, [{
    operation: 'bookmark.delete',
    bookmarkId: 'a',
    payload: null,
  }]);
});
