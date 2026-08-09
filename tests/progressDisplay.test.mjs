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

test('uses comparable sync revisions before device timestamps', () => {
  const local = {
    book: { bookId: 'book', cfi: 'local', progressPercent: 20, lastRead: 999, syncRevision: 2 },
  };
  const remote = {
    book: { bookId: 'book', cfi: 'remote', progressPercent: 80, lastRead: 1, syncRevision: 3 },
  };
  assert.equal(mergeLatestProgressForDisplay(local, remote).book.cfi, 'remote');
});

test('keeps an explicitly ignored remote revision off the shelf until a newer head arrives', () => {
  const local = {
    book: {
      bookId: 'book',
      cfi: 'local',
      progressPercent: 20,
      lastRead: 10,
      syncRevision: 2,
      ignoredRemoteRevision: 3,
    },
  };
  const ignoredRemote = {
    book: {
      bookId: 'book',
      cfi: 'ignored-remote',
      progressPercent: 80,
      lastRead: 20,
      syncRevision: 3,
    },
  };
  assert.equal(mergeLatestProgressForDisplay(local, ignoredRemote).book.cfi, 'local');

  const newerRemote = {
    book: { ...ignoredRemote.book, cfi: 'newer-remote', syncRevision: 4 },
  };
  assert.equal(mergeLatestProgressForDisplay(local, newerRemote).book.cfi, 'newer-remote');
});
