import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ANNOTATION_CONTEXT_LENGTH,
  HIGHLIGHT_COLORS,
  isAnnotation,
  normalizeAnnotationText,
  verifyAnnotationAnchor,
} from '../src/lib/annotationPolicy.ts';

const annotation = (overrides = {}) => ({
  id: 'annotation-1',
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 0,
  rangeCfi: 'epubcfi(/6/2!/4/2,/1:0,/1:5)',
  quote: 'hello',
  prefix: 'before ',
  suffix: ' after',
  colorId: 'yellow',
  note: '',
  progressPercent: 25,
  chapter: 'Chapter 1',
  createdAtClient: 100,
  updatedAtClient: 100,
  anchorState: 'active',
  ...overrides,
});

test('defines five stable highlight color ids', () => {
  assert.deepEqual(HIGHLIGHT_COLORS.map(({ id }) => id), [
    'yellow', 'green', 'blue', 'pink', 'purple',
  ]);
});

test('validates the local highlight schema and bounds', () => {
  assert.equal(isAnnotation(annotation()), true);
  assert.equal(isAnnotation(annotation({ colorId: 'orange' })), false);
  assert.equal(isAnnotation(annotation({ rangeCfi: '#fragment' })), false);
  assert.equal(isAnnotation(annotation({ rangeCfi: 'epubcfi(' })), false);
  assert.equal(isAnnotation(annotation({ rangeCfi: 'epubcfi()' })), false);
  assert.equal(isAnnotation(annotation({ rangeCfi: 'epubcfi(/6/2' })), false);
  assert.equal(isAnnotation(annotation({ quote: '   ' })), false);
  assert.equal(isAnnotation(annotation({ prefix: 'x'.repeat(ANNOTATION_CONTEXT_LENGTH + 1) })), false);
  assert.equal(isAnnotation(annotation({ updatedAtClient: 99 })), false);
});

test('normalizes layout whitespace but rejects CFI drift into different context', () => {
  assert.equal(normalizeAnnotationText('  hello\n world '), 'hello world');
  assert.equal(verifyAnnotationAnchor(annotation(), {
    quote: ' hello ',
    prefix: 'before',
    suffix: 'after ',
  }), true);
  assert.equal(verifyAnnotationAnchor(annotation(), {
    quote: 'hello',
    prefix: 'different',
    suffix: 'after',
  }), false);
});
