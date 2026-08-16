import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyShelfCatalog,
  applyShelfProgress,
  EMPTY_SHELF_FILTERS,
  filterAndSortPreparedBooks,
  prepareShelfBooks,
} from '../src/components/shelf/bookUtils.ts';
import {
  getNextShelfVisibleCount,
  SHELF_PAGE_SIZE,
} from '../src/components/shelf/progressiveBooks.ts';
import {
  getNextShelfTagCount,
  SHELF_TAG_PAGE_SIZE,
} from '../src/components/shelf/filterTags.ts';
import { searchPublicBookCatalogTags } from '../src/components/shelf/tagSearch.ts';

const book = (id, name, source = 'cloud') => ({
  id,
  name,
  source,
  mimeType: 'application/epub+zip',
});

const timestamp = (time) => ({ toDate: () => new Date(time) });

test('reveals popular tags in fixed groups of fifteen', () => {
  assert.equal(SHELF_TAG_PAGE_SIZE, 15);
  assert.equal(getNextShelfTagCount(15, 41), 30);
  assert.equal(getNextShelfTagCount(30, 41), 41);
  assert.equal(getNextShelfTagCount(41, 41), 41);
});

test('ranks exact hashtag matches before prefix and substring matches', () => {
  const tags = [
    { id: 1, label: '하렘물', titleCount: 900 },
    { id: 2, label: '고수위하렘', titleCount: 800 },
    { id: 3, label: '하렘', titleCount: 700 },
  ];
  assert.deepEqual(
    searchPublicBookCatalogTags(tags, ' 하렘 ').map(({ id }) => id),
    [3, 1, 2],
  );
});

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

const catalog = ({
  platformMask = 1,
  genreId = 0,
  tagIds = [],
  score = 0,
  ranks = [score, null, null],
} = {}) => ({
  record: {
    id: score,
    platformMask,
    canonicalGenreId: genreId,
    tagIds,
    popularityScore: score,
    sourceRanks: ranks,
    sourceCounts: [100, null, null],
  },
  genreLabel: genreId === null ? null : `genre-${genreId}`,
  tags: tagIds.map((id) => ({ id, label: `tag-${id}`, titleCount: 1 })),
});

test('combines source OR, genre OR, tag AND, and category AND filters', () => {
  const books = applyShelfCatalog(
    applyShelfProgress(prepareShelfBooks([
      book('series-fantasy', '가'),
      book('kakao-romance', '나'),
      book('unmatched', '다'),
    ]), {}),
    new Map([
      ['series-fantasy', catalog({ platformMask: 1, genreId: 2, tagIds: [7, 8] })],
      ['kakao-romance', catalog({ platformMask: 2, genreId: 3, tagIds: [7] })],
    ]),
  );
  assert.deepEqual(
    filterAndSortPreparedBooks(books, '', 'alpha', [], {
      sources: ['series', 'none'],
      genreIds: [],
      tagIds: [],
    }).map(({ id }) => id),
    ['series-fantasy', 'unmatched'],
  );
  assert.deepEqual(
    filterAndSortPreparedBooks(books, '', 'alpha', [], {
      sources: ['series', 'kakao'],
      genreIds: [2, 3],
      tagIds: [7, 8],
    }).map(({ id }) => id),
    ['series-fantasy'],
  );
});

test('sorts by normalized popularity and keeps missing metadata last', () => {
  const books = applyShelfCatalog(
    applyShelfProgress(prepareShelfBooks([
      book('low', '나'),
      book('missing', '가'),
      book('high', '다'),
    ]), {}),
    new Map([
      ['low', catalog({ score: 2500 })],
      ['high', catalog({ platformMask: 3, score: 9000, ranks: [8000, 10000, null] })],
    ]),
  );
  assert.deepEqual(
    filterAndSortPreparedBooks(
      books,
      '',
      'popularity',
      ['missing'],
      EMPTY_SHELF_FILTERS,
    ).map(({ id }) => id),
    ['high', 'low', 'missing'],
  );
});

test('preserves original order inside the missing-popularity tail', () => {
  const books = applyShelfProgress(prepareShelfBooks([
    book('missing-z', '하'),
    book('ranked', '가'),
    book('missing-a', '나'),
  ]), {});
  const withCatalog = applyShelfCatalog(books, new Map([
    ['ranked', catalog({ score: 5000 })],
  ]));
  assert.deepEqual(
    filterAndSortPreparedBooks(
      withCatalog,
      '',
      'popularity',
      ['missing-a'],
      EMPTY_SHELF_FILTERS,
    ).map(({ id }) => id),
    ['ranked', 'missing-z', 'missing-a'],
  );
});

test('recent import priority never bypasses an active metadata filter', () => {
  const books = applyShelfCatalog(
    applyShelfProgress(prepareShelfBooks([
      book('matched', '가'),
      book('imported-unmatched', '나'),
    ]), {}),
    new Map([['matched', catalog({ platformMask: 2 })]]),
  );
  assert.deepEqual(
    filterAndSortPreparedBooks(books, '', 'recent', ['imported-unmatched'], {
      sources: ['kakao'],
      genreIds: [],
      tagIds: [],
    }).map(({ id }) => id),
    ['matched'],
  );
});
