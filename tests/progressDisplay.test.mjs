import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeLatestProgressForDisplay } from '../src/lib/progressDisplay.ts';

const progress = (bookId, progressPercent, lastRead) => ({
  bookId,
  cfi: `cfi-${progressPercent}`,
  progressPercent,
  lastRead,
});

test('shows remote progress on the shelf even when the device has no local progress', () => {
  assert.deepEqual(
    mergeLatestProgressForDisplay({}, { book: progress('book', 70, 20) }),
    { book: progress('book', 70, 20) },
  );
});

test('shows the newest progress without overwriting a newer local display value', () => {
  const local = {
    newerLocal: progress('newerLocal', 80, 30),
    olderLocal: progress('olderLocal', 10, 10),
  };
  const remote = {
    newerLocal: progress('newerLocal', 20, 20),
    olderLocal: progress('olderLocal', 60, 40),
  };
  assert.deepEqual(mergeLatestProgressForDisplay(local, remote), {
    newerLocal: local.newerLocal,
    olderLocal: remote.olderLocal,
  });
});
