import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  clampTapZonePercent,
  getEffectiveNavigationMode,
  getNavigationOptions,
  getReaderKeyboardAction,
  getReaderTapAction,
} from '../src/lib/readerNavigation.ts';
import {
  createPendingSliderMove,
  reuseOrStageReaderJump,
} from '../src/lib/readerNavigationCommit.ts';

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

test('freezes recovery bookmarks before slider navigation and reuses them on retry', () => {
  let stagedFrom = null;
  const move = createPendingSliderMove({
    targetPercent: 80,
    startPercent: 20,
    startCfi: 'start-cfi',
    stageAutoBookmark: (cfi, percent) => {
      stagedFrom = { cfi, percent };
      return [{ id: 'frozen', type: 'auto', cfi, progressPercent: percent }];
    },
  });
  assert.deepEqual(stagedFrom, { cfi: 'start-cfi', percent: 20 });
  assert.equal(move.stagedBookmarks[0].cfi, 'start-cfi');

  let restaged = 0;
  const first = reuseOrStageReaderJump(null, 'cfi:target', () => {
    restaged += 1;
    return move.stagedBookmarks;
  });
  const retry = reuseOrStageReaderJump(first, 'cfi:target', () => {
    restaged += 1;
    return [{ id: 'wrong-live-target', type: 'auto', cfi: 'target-cfi' }];
  });
  assert.equal(retry, first);
  assert.equal(retry.bookmarks[0].cfi, 'start-cfi');
  assert.equal(restaged, 1);
});

test('keeps arrow key navigation mode-specific', () => {
  assert.equal(getReaderKeyboardAction('scroll', 'ArrowDown'), 'next');
  assert.equal(getReaderKeyboardAction('page', 'ArrowDown'), 'next');
  assert.equal(getReaderKeyboardAction('left-right', 'ArrowDown'), null);
  assert.equal(getReaderKeyboardAction('left-right', 'ArrowRight'), 'next');
  assert.equal(getReaderKeyboardAction('all-dir', 'ArrowLeft'), 'prev');
});

test('scopes viewport overscroll suppression to paged reader modes', async () => {
  const [readerSource, globalStyles] = await Promise.all([
    readFile(new URL('../src/components/EpubReader.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
  ]);

  assert.match(readerSource, /if \(effectiveNavMode === 'scroll'\) return;/);
  assert.match(readerSource, /classList\.add\('reader-paged-navigation'\)/);
  assert.match(readerSource, /classList\.remove\('reader-paged-navigation'\)/);
  assert.match(
    globalStyles,
    /html\.reader-paged-navigation,\s*body\.reader-paged-navigation\s*\{\s*overscroll-behavior: none;/,
  );
});
