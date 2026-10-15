import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAutoReadWordDelay,
  splitAutoReadFocus,
  tokenizeAutoReadText,
} from '../src/lib/readerAutoRead.ts';

test('tokenizes Korean and English across whitespace while preserving UTF-16 offsets', () => {
  const text = '안녕,\tworld!\n😀 다음 문장.';
  const words = tokenizeAutoReadText(text);

  assert.deepEqual(words.map(({ text: value, start, end }) => ({ value, start, end })), [
    { value: '안녕,', start: 0, end: 3 },
    { value: 'world!', start: 4, end: 10 },
    { value: '😀', start: 11, end: 13 },
    { value: '다음', start: 14, end: 16 },
    { value: '문장.', start: 17, end: 20 },
  ]);
  assert.equal(text.slice(words[2].start, words[2].end), '😀');
  assert.deepEqual(tokenizeAutoReadText(' \n\t '), []);
});

test('applies base, sentence, and pause delays with bounded or default WPM', () => {
  assert.equal(getAutoReadWordDelay('plain', 300), 200);
  assert.equal(getAutoReadWordDelay('done!”', 300), 400);
  assert.equal(getAutoReadWordDelay('next；', 300), 300);
  assert.equal(getAutoReadWordDelay('slow', 1), 1_000);
  assert.equal(getAutoReadWordDelay('fast', 10_000), 60);
  assert.equal(getAutoReadWordDelay('default', Number.NaN), 60_000 / 330);
  assert.equal(getAutoReadWordDelay('default', Number.POSITIVE_INFINITY), 60_000 / 330);
});

test('splits the center grapheme, including emoji sequences and combining text', () => {
  assert.deepEqual(splitAutoReadFocus('A👩🏽‍🚀B'), {
    before: 'A',
    focus: '👩🏽‍🚀',
    after: 'B',
  });
  assert.deepEqual(splitAutoReadFocus('가나'), {
    before: '',
    focus: '가',
    after: '나',
  });
  assert.deepEqual(splitAutoReadFocus(''), { before: '', focus: '', after: '' });
});
