import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY,
  hideReadingStatisticsRound,
  readHiddenReadingStatisticsSessionIds,
} from '../src/lib/readingStatisticsSessionVisibility.ts';

const createStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
  };
};

test('keeps hidden reading sessions isolated by owner and selected round', () => {
  const storage = createStorage();
  assert.equal(hideReadingStatisticsRound(
    'owner-a', 'book-1', 1, ['session-a'], storage, 100,
  ), true);
  assert.equal(hideReadingStatisticsRound(
    'owner-b', 'book-1', 2, ['session-b'], storage, 200,
  ), true);

  assert.deepEqual([...readHiddenReadingStatisticsSessionIds('owner-a', storage)], ['session-a']);
  assert.deepEqual([...readHiddenReadingStatisticsSessionIds('owner-b', storage)], ['session-b']);
});

test('merges newly visible sessions when the same round is hidden again', () => {
  const storage = createStorage();
  assert.equal(hideReadingStatisticsRound(
    'owner-a', 'book-1', 1, ['session-a'], storage, 100,
  ), true);
  assert.equal(hideReadingStatisticsRound(
    'owner-a', 'book-1', 1, ['session-b'], storage, 200,
  ), true);

  assert.deepEqual(
    [...readHiddenReadingStatisticsSessionIds('owner-a', storage)].sort(),
    ['session-a', 'session-b'],
  );
});

test('ignores malformed entries and refuses an empty round deletion', () => {
  const storage = createStorage();
  storage.setItem(READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY, JSON.stringify({
    version: 1,
    entries: [
      { ownerKey: 'owner-a', bookId: 'book-1', roundNumber: 0, sessionIds: ['x'], hiddenAt: 100 },
      { ownerKey: 'owner-a', bookId: 'book-1', roundNumber: 1, sessionIds: [], hiddenAt: 100 },
      null,
    ],
  }));
  assert.equal(hideReadingStatisticsRound(
    'owner-a', 'book-1', 1, [], storage, 200,
  ), false);
  assert.deepEqual([...readHiddenReadingStatisticsSessionIds('owner-a', storage)], []);
});
