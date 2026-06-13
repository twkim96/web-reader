import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getEffectiveNavigationMode,
  getNavigationOptions,
} from '../src/lib/readerNavigation.ts';

test('preserves tap navigation modes for fixed-layout books', () => {
  assert.equal(getEffectiveNavigationMode('page', true), 'page');
  assert.equal(getEffectiveNavigationMode('left-right', true), 'left-right');
  assert.equal(getEffectiveNavigationMode('all-dir', true), 'all-dir');
});

test('falls back from scroll only for fixed-layout books', () => {
  assert.equal(getEffectiveNavigationMode('scroll', true), 'left-right');
  assert.equal(getEffectiveNavigationMode('scroll', false), 'scroll');
});

test('hides only the unsupported scroll option for fixed-layout books', () => {
  assert.deepEqual(
    getNavigationOptions(true).map(({ value }) => value),
    ['page', 'left-right', 'all-dir'],
  );
});
