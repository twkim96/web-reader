import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAnnotationPalette } from '../src/lib/annotationPalette.ts';
import {
  buildLibraryAnnotationIndex,
  groupAnnotationsByColor,
  queryAnnotations,
  queryLibraryAnnotationIndex,
} from '../src/lib/annotationQuery.ts';

const makeAnnotation = (id, overrides = {}) => ({
  id,
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: `epubcfi(/6/2!/4/2,/1:${id.length},/1:${id.length + 1})`,
  quote: id,
  prefix: '',
  suffix: '',
  colorId: 'yellow',
  note: '',
  progressPercent: 50,
  chapter: '',
  createdAtClient: 100,
  updatedAtClient: 100,
  anchorState: 'active',
  ...overrides,
});

test('searches quote, note, chapter and configured palette meaning', () => {
  const palette = normalizeAnnotationPalette(undefined).map((item) => (
    item.id === 'blue' ? { ...item, meaning: '설정 자료' } : item
  ));
  const annotations = [
    makeAnnotation('first', { quote: '한글 원문', colorId: 'yellow' }),
    makeAnnotation('second', { note: 'Remember this', colorId: 'green' }),
    makeAnnotation('third', { chapter: '서장', colorId: 'pink' }),
    makeAnnotation('fourth', { colorId: 'blue' }),
  ];
  assert.deepEqual(queryAnnotations(annotations, palette, { query: '한글' }).map(({ id }) => id), ['first']);
  assert.deepEqual(queryAnnotations(annotations, palette, { query: 'remember' }).map(({ id }) => id), ['second']);
  assert.deepEqual(queryAnnotations(annotations, palette, { query: '서장' }).map(({ id }) => id), ['third']);
  assert.deepEqual(queryAnnotations(annotations, palette, { query: '설정' }).map(({ id }) => id), ['fourth']);
});

test('filters notes and supports reading, created and updated order', () => {
  const palette = normalizeAnnotationPalette(undefined);
  const annotations = [
    makeAnnotation('a', { progressPercent: 80, createdAtClient: 100, updatedAtClient: 300, note: 'yes' }),
    makeAnnotation('b', { progressPercent: 10, createdAtClient: 300, updatedAtClient: 100 }),
    makeAnnotation('c', { progressPercent: 40, createdAtClient: 200, updatedAtClient: 200, note: 'yes' }),
  ];
  assert.deepEqual(queryAnnotations(annotations, palette).map(({ id }) => id), ['b', 'c', 'a']);
  assert.deepEqual(queryAnnotations(annotations, palette, { sort: 'created-desc' }).map(({ id }) => id), ['b', 'c', 'a']);
  assert.deepEqual(queryAnnotations(annotations, palette, { sort: 'updated-desc' }).map(({ id }) => id), ['a', 'c', 'b']);
  assert.deepEqual(queryAnnotations(annotations, palette, { noteOnly: true }).map(({ id }) => id), ['c', 'a']);
});

test('groups in stable five-color order including empty groups', () => {
  const groups = groupAnnotationsByColor([
    makeAnnotation('a', { colorId: 'purple' }),
    makeAnnotation('b', { colorId: 'yellow' }),
  ]);
  assert.deepEqual(groups.map(({ colorId }) => colorId), ['yellow', 'green', 'blue', 'pink', 'purple']);
  assert.deepEqual(groups.map(({ annotations }) => annotations.length), [1, 0, 0, 0, 1]);
});

test('searches and filters a normalized cross-book annotation index', () => {
  const palette = normalizeAnnotationPalette(undefined);
  const first = makeAnnotation('first', {
    bookId: 'book-a',
    quote: 'ＡＢＣ 한글 문장',
    note: '중요 메모',
    colorId: 'green',
    updatedAtClient: 10,
  });
  const second = makeAnnotation('second', {
    bookId: 'book-b',
    quote: '다른 문장',
    note: '',
    colorId: 'blue',
    updatedAtClient: 20,
  });
  const index = buildLibraryAnnotationIndex(
    [first, second],
    [{ id: 'book-a', name: '첫 번째 책' }, { id: 'book-b', name: '두 번째 책' }],
    palette,
  );
  assert.deepEqual(
    queryLibraryAnnotationIndex(index, { query: 'abc 한글' })
      .map(({ annotation }) => annotation.id),
    ['first'],
  );
  assert.deepEqual(
    queryLibraryAnnotationIndex(index, { query: '두 번째', colorId: 'blue' })
      .map(({ annotation }) => annotation.id),
    ['second'],
  );
  assert.deepEqual(
    queryLibraryAnnotationIndex(index, { bookId: 'book-a', noteOnly: true })
      .map(({ annotation }) => annotation.id),
    ['first'],
  );
  assert.deepEqual(
    queryLibraryAnnotationIndex(index, { sort: 'updated-desc' })
      .map(({ annotation }) => annotation.id),
    ['second', 'first'],
  );
});

test('keeps same-title books grouped by stable book id in reading order', () => {
  const palette = normalizeAnnotationPalette(undefined);
  const index = buildLibraryAnnotationIndex([
    makeAnnotation('a30', { bookId: 'book-a', progressPercent: 30 }),
    makeAnnotation('b20', { bookId: 'book-b', progressPercent: 20 }),
    makeAnnotation('a10', { bookId: 'book-a', progressPercent: 10 }),
  ], [
    { id: 'book-a', name: 'same.epub' },
    { id: 'book-b', name: 'same.epub' },
  ], palette);
  assert.deepEqual(
    queryLibraryAnnotationIndex(index, { sort: 'book-reading' })
      .map(({ annotation }) => annotation.id),
    ['a10', 'a30', 'b20'],
  );
});
