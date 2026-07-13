import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAutoBookmarkName,
  getBookmarkPosition,
} from '../src/hooks/reader/bookmarkPositionPolicy.ts';

test('stores the measurable viewport range CFI while keeping the progress anchor', () => {
  assert.deepEqual(getBookmarkPosition('range-cfi', 'anchor-cfi'), {
    bookmarkCfi: 'range-cfi',
    progressCfi: 'range-cfi',
    anchorCfi: 'anchor-cfi',
  });
});

test('falls back to the range CFI for old relocate events without an anchor', () => {
  assert.deepEqual(getBookmarkPosition('range-cfi', ''), {
    bookmarkCfi: 'range-cfi',
    progressCfi: 'range-cfi',
    anchorCfi: 'range-cfi',
  });
});

test('keeps automatic bookmark labels free of the previous-location prefix', () => {
  assert.equal(getAutoBookmarkName('현재 문단 미리보기'), '현재 문단 미리보기');
  assert.equal(getAutoBookmarkName('이전 위치: 기존 문단'), '기존 문단');
  assert.equal(getAutoBookmarkName('  '), '북마크');
});
