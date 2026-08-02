import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeAnnotationPalette } from '../src/lib/annotationPalette.ts';
import { groupAnnotationsByColor, queryAnnotations } from '../src/lib/annotationQuery.ts';

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
