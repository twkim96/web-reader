import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampTapZonePercent,
  getEffectiveNavigationMode,
  getNavigationOptions,
  getReaderKeyboardAction,
  getReaderTapAction,
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

test('keeps the existing 33% vertical and 30% horizontal tap zones', () => {
  assert.equal(getReaderTapAction({
    navMode: 'page',
    clientX: 50,
    clientY: 32,
    width: 100,
    height: 100,
    topBottomPercent: 33,
    leftRightPercent: 30,
  }), 'prev');
  assert.equal(getReaderTapAction({
    navMode: 'page',
    clientX: 50,
    clientY: 50,
    width: 100,
    height: 100,
    topBottomPercent: 33,
    leftRightPercent: 30,
  }), 'controls');
  assert.equal(getReaderTapAction({
    navMode: 'left-right',
    clientX: 71,
    clientY: 50,
    width: 100,
    height: 100,
    topBottomPercent: 33,
    leftRightPercent: 30,
  }), 'next');
});

test('uses configurable tap zones and preserves a central controls area', () => {
  assert.equal(getReaderTapAction({
    navMode: 'all-dir',
    clientX: 50,
    clientY: 40,
    width: 100,
    height: 100,
    topBottomPercent: 40,
    leftRightPercent: 20,
  }), 'controls');
  assert.equal(getReaderTapAction({
    navMode: 'all-dir',
    clientX: 15,
    clientY: 50,
    width: 100,
    height: 100,
    topBottomPercent: 40,
    leftRightPercent: 20,
  }), 'prev');
  assert.equal(clampTapZonePercent(0, 33), 10);
  assert.equal(clampTapZonePercent(50, 30), 45);
});

test('maps spacebar to the same next action in scroll and tap modes', () => {
  assert.equal(getReaderKeyboardAction('scroll', ' '), 'next');
  assert.equal(getReaderKeyboardAction('page', ' '), 'next');
  assert.equal(getReaderKeyboardAction('left-right', 'Spacebar'), 'next');
  assert.equal(getReaderKeyboardAction('all-dir', 'Space'), 'next');
});

test('keeps arrow key navigation mode-specific', () => {
  assert.equal(getReaderKeyboardAction('scroll', 'ArrowDown'), 'next');
  assert.equal(getReaderKeyboardAction('page', 'ArrowDown'), 'next');
  assert.equal(getReaderKeyboardAction('left-right', 'ArrowDown'), null);
  assert.equal(getReaderKeyboardAction('left-right', 'ArrowRight'), 'next');
  assert.equal(getReaderKeyboardAction('all-dir', 'ArrowLeft'), 'prev');
});
