import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearProgressCommitBaseline,
  getProgressCommitBaseline,
  rebaseProgressCommitBaseline,
  resetProgressCommitBaselinesForTests,
} from '../src/lib/progressCommitBaseline.ts';

const progress = (cfi) => ({
  bookId: 'book-1',
  cfi,
  progressPercent: 10,
  lastRead: 1,
});

test.beforeEach(resetProgressCommitBaselinesForTests);

test('keeps committed baselines isolated by owner and book', () => {
  const first = progress('first');
  assert.equal(getProgressCommitBaseline('owner-a', 'book-1', first), first);
  assert.equal(getProgressCommitBaseline('owner-a', 'book-1', progress('ignored')), first);
  assert.equal(getProgressCommitBaseline('owner-b', 'book-1', progress('other')).cfi, 'other');
});

test('rebases after remote adoption and can clear a deleted book', () => {
  rebaseProgressCommitBaseline('owner-a', 'book-1', progress('remote'));
  assert.equal(getProgressCommitBaseline('owner-a', 'book-1', undefined).cfi, 'remote');
  clearProgressCommitBaseline('owner-a', 'book-1');
  assert.equal(getProgressCommitBaseline('owner-a', 'book-1', undefined), undefined);
});
