import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getStoredAnnotationPalette,
  normalizeAnnotationPalette,
  saveStoredAnnotationPalette,
} from '../src/lib/annotationPalette.ts';

const ownerA = 'firebase:owner-a|library:local';
const ownerB = 'firebase:owner-b|library:local';

const makeStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
};

test('normalizes a palette to five stable colors and bounded labels', () => {
  const palette = normalizeAnnotationPalette([
    { id: 'yellow', label: '  핵심  ', meaning: ' x '.repeat(100) },
    { id: 'orange', label: 'ignore', meaning: 'ignore' },
  ]);
  assert.deepEqual(palette.map(({ id }) => id), ['yellow', 'green', 'blue', 'pink', 'purple']);
  assert.equal(palette[0].label, '핵심');
  assert.equal(palette[0].meaning.length <= 80, true);
  assert.equal(palette[1].label, '초록');
  assert.equal(palette[1].meaning, '기억');
});

test('stores palettes independently for each owner', () => {
  const storage = makeStorage();
  const palette = normalizeAnnotationPalette(undefined);
  palette[0] = { ...palette[0], label: '별표', meaning: '가장 중요' };
  saveStoredAnnotationPalette(ownerA, palette, storage);

  assert.equal(getStoredAnnotationPalette(ownerA, storage)[0].label, '별표');
  assert.equal(getStoredAnnotationPalette(ownerB, storage)[0].label, '노랑');
});

test('falls back safely when stored JSON is invalid', () => {
  const storage = {
    getItem: () => '{bad json',
  };
  assert.equal(getStoredAnnotationPalette(ownerA, storage)[0].label, '노랑');
});
