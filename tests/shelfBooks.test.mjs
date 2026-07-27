import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyShelfProgress,
  filterAndSortPreparedBooks,
  prepareShelfBooks,
} from '../src/components/shelf/bookUtils.ts';
import {
  getNextShelfVisibleCount,
  SHELF_PAGE_SIZE,
} from '../src/components/shelf/progressiveBooks.ts';

const book = (id, name, source = 'cloud') => ({
  id,
  name,
  source,
  mimeType: 'application/epub+zip',
});

const timestamp = (time) => ({ toDate: () => new Date(time) });

test('merges local and cloud reading books into one recent order', () => {
  const books = [
    book('cloud-unread', 'Cloud Unread'),
    book('local-reading', 'Local Reading', 'local'),
    book('cloud-reading', 'Cloud Reading'),
    book('local-unread', 'Local Unread', 'local'),
  ];
  const prepared = applyShelfProgress(prepareShelfBooks(books), {
    'local-reading': {
      progressPercent: 50,
      lastRead: timestamp('2026-06-14T10:00:00Z'),
    },
    'cloud-reading': {
      progressPercent: 20,
      lastRead: timestamp('2026-06-14T11:00:00Z'),
    },
  });

  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'recent').map(({ id }) => id),
    ['cloud-reading', 'local-reading', 'cloud-unread', 'local-unread'],
  );
});

test('only progress strictly between zero and one hundred is prioritized', () => {
  const books = [book('zero', 'Zero'), book('reading', 'Reading'), book('done', 'Done')];
  const lastRead = timestamp('2026-06-14T11:00:00Z');
  const prepared = applyShelfProgress(prepareShelfBooks(books), {
    zero: { progressPercent: 0, lastRead },
    reading: { progressPercent: 50, lastRead },
    done: { progressPercent: 100, lastRead },
  });

  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'recent').map(({ id }) => id),
    ['reading', 'zero', 'done'],
  );
});

test('alpha mode keeps the reading group first and sorts inside each group', () => {
  const books = [
    book('unread-b', '나'),
    book('reading-b', '라'),
    book('unread-a', '가'),
    book('reading-a', '다'),
  ];
  const prepared = applyShelfProgress(prepareShelfBooks(books), {
    'reading-a': { progressPercent: 10 },
    'reading-b': { progressPercent: 10 },
  });

  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'alpha').map(({ id }) => id),
    ['reading-a', 'reading-b', 'unread-a', 'unread-b'],
  );
});

test('searches the full 1100-book set before selecting a visible page', () => {
  const books = Array.from({ length: 1100 }, (_, index) => (
    book(`book-${index}`, `Book ${index}`)
  ));
  const prepared = applyShelfProgress(prepareShelfBooks(books), {});
  const result = filterAndSortPreparedBooks(prepared, 'Book 1099', 'recent');

  assert.deepEqual(result.map(({ id }) => id), ['book-1099']);
  assert.equal(getNextShelfVisibleCount(0, books.length), SHELF_PAGE_SIZE);
  assert.equal(getNextShelfVisibleCount(1050, books.length), 1100);
  assert.equal(getNextShelfVisibleCount(1100, books.length), 1100);
});

test('preserves source order for equal recent-sort groups', () => {
  const books = [book('first', 'Z'), book('second', 'A'), book('third', 'M')];
  const prepared = applyShelfProgress(prepareShelfBooks(books), {});

  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'recent').map(({ id }) => id),
    ['first', 'second', 'third'],
  );
});

test('keeps books imported during this page lifetime above either saved sort mode', () => {
  const books = [
    book('reading', '다'),
    book('first-import', '라'),
    book('unread', '가'),
    book('second-import', '나'),
  ];
  const prepared = applyShelfProgress(prepareShelfBooks(books), {
    reading: { progressPercent: 50, lastRead: timestamp('2026-07-27T01:00:00Z') },
  });
  const imported = ['first-import', 'second-import'];

  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'recent', imported).map(({ id }) => id),
    ['first-import', 'second-import', 'reading', 'unread'],
  );
  assert.deepEqual(
    filterAndSortPreparedBooks(prepared, '', 'alpha', imported).map(({ id }) => id),
    ['first-import', 'second-import', 'reading', 'unread'],
  );
});
