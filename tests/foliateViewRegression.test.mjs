import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findContentByIndex,
  isCJKLanguage,
} from '../public/foliate-js/view-policy.js';

test('recognizes the canonical CJK language codes', () => {
  assert.equal(isCJKLanguage('ko'), true);
  assert.equal(isCJKLanguage('ko-KR'), true);
  assert.equal(isCJKLanguage('ja'), true);
  assert.equal(isCJKLanguage('zh-CN'), true);
  assert.equal(isCJKLanguage('en-US'), false);
});

test('finds renderer content by index without mutating candidates', () => {
  const contents = [
    { index: 0, doc: { title: 'zero' } },
    { index: 2, doc: { title: 'two' } },
  ];
  const indexesBefore = contents.map(({ index }) => index);

  assert.equal(findContentByIndex(contents, 0), contents[0]);
  assert.equal(findContentByIndex(contents, 2), contents[1]);
  assert.equal(findContentByIndex(contents, 1), undefined);
  assert.deepEqual(contents.map(({ index }) => index), indexesBefore);
});
