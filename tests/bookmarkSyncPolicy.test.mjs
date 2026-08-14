import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyManualBookmarkMutation,
  diffManualBookmarks,
  manualBookmarkMutationToSyncChange,
} from '../src/lib/bookmarkSyncPolicy.ts';

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

test('explicit bookmark upsert preserves unrelated remote bookmarks and emits only the intended target', () => {
  const remote = bookmark('remote-y', { createdAt: 20 });
  const local = bookmark('local-x', { createdAt: 30 });
  const mutation = { kind: 'upsert', bookmark: local };

  const next = applyManualBookmarkMutation([remote], mutation);
  const change = manualBookmarkMutationToSyncChange(mutation, 40);

  assert.deepEqual(next.map(({ id }) => id), ['local-x', 'remote-y']);
  assert.equal(change.operation, 'bookmark.upsert');
  assert.equal(change.bookmarkId, 'local-x');
});

test('explicit bookmark delete does not create tombstones for unrelated ids', () => {
  const local = bookmark('local-x');
  const remote = bookmark('remote-y');
  const mutation = { kind: 'delete', bookmarkId: 'local-x' };

  const next = applyManualBookmarkMutation([local, remote], mutation);
  const change = manualBookmarkMutationToSyncChange(mutation, 40);

  assert.deepEqual(next.map(({ id }) => id), ['remote-y']);
  assert.deepEqual(change, {
    operation: 'bookmark.delete',
    bookmarkId: 'local-x',
    payload: null,
  });
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
