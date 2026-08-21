import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeRemotePositionUpdates } from '../src/lib/remoteProgressState.ts';

const position = (revision, overrides = {}) => ({
  operation: 'set',
  bookId: 'book-1',
  cfi: `cfi-${revision}`,
  anchorCfi: `anchor-${revision}`,
  progressPercent: revision * 10,
  lastRead: revision * 100,
  syncRevision: revision,
  acceptedEventId: `event-${revision}`,
  ...overrides,
});

test('progress snapshots cannot overwrite or resurrect bookmark state', () => {
  const previous = {
    'book-1': {
      ...position(1),
      bookmarks: [{
        id: 'bookmark-b',
        type: 'manual',
        name: 'B',
        cfi: 'bookmark-cfi',
        progressPercent: 10,
        createdAt: 1,
        color: '#f59e0b',
      }],
    },
  };

  const afterPosition = mergeRemotePositionUpdates(previous, {
    'book-1': position(2),
  });
  assert.equal(afterPosition['book-1'].cfi, 'cfi-2');
  assert.equal('bookmarks' in afterPosition['book-1'], false);

  const afterAnotherPosition = mergeRemotePositionUpdates({
    'book-1': { ...position(2), bookmarks: [] },
  }, {
    'book-1': position(3),
  });
  assert.equal('bookmarks' in afterAnotherPosition['book-1'], false);
});

test('an older listener snapshot cannot overwrite a newer targeted foreground refresh', () => {
  const newer = position(5);
  const next = mergeRemotePositionUpdates({
    'book-1': newer,
  }, {
    'book-1': position(4),
  });

  assert.equal(next['book-1'].syncRevision, 5);
  assert.equal(next['book-1'].acceptedEventId, 'event-5');
  assert.equal(next['book-1'].cfi, 'cfi-5');
});

test('removed progress heads are removed without touching other books', () => {
  const next = mergeRemotePositionUpdates({
    'book-1': position(1),
    'book-2': { ...position(1), bookId: 'book-2' },
  }, {}, new Set(['book-1']));

  assert.equal(next['book-1'], undefined);
  assert.equal(next['book-2'].bookId, 'book-2');
});
