import test from 'node:test';
import assert from 'node:assert/strict';

import { getReaderTitleLayout } from '../src/lib/readerTitleLayout.ts';

test('centers a title while its natural one-line width fits beside the close button', () => {
  assert.equal(getReaderTitleLayout({
    viewportWidth: 390,
    leftInset: 12,
    rightLimit: 328,
    titleWidth: 257,
  }), 'center');
});

test('right-aligns titles that would cross either centered boundary', () => {
  assert.equal(getReaderTitleLayout({
    viewportWidth: 390,
    leftInset: 12,
    rightLimit: 328,
    titleWidth: 276,
  }), 'right');
  assert.equal(getReaderTitleLayout({
    viewportWidth: 390,
    leftInset: 40,
    rightLimit: 378,
    titleWidth: 330,
  }), 'right');
});

test('uses the inset close-button edge on wide reader layouts', () => {
  assert.equal(getReaderTitleLayout({
    viewportWidth: 2560,
    leftInset: 16,
    rightLimit: 1794,
    titleWidth: 1200,
  }), 'right');
});
