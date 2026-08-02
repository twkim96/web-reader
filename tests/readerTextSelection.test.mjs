import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasNonCollapsedSelection,
  isPointInsideRects,
  isRapidReaderNavigationTap,
  isShortReaderTapGesture,
  isPublicationLinkTarget,
  isSelectionRelocateReason,
  mapFrameClientPoint,
  mapFrameRectToViewport,
  mapSelectionRectToViewport,
  pickSelectionAnchorRect,
} from '../src/lib/readerTextSelection.ts';

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

test('uses the last visible non-empty range rect for the selection menu', () => {
  assert.deepEqual(
    pickSelectionAnchorRect([
      rect(-40, 20, 20, 10),
      rect(10, 20, 40, 12),
      rect(15, 42, 35, 12),
      rect(15, 200, 35, 12),
    ], 100, 100),
    rect(15, 42, 35, 12),
  );
});

test('falls back to the last usable rect when the selection is offscreen', () => {
  assert.deepEqual(
    pickSelectionAnchorRect([
      rect(10, 180, 0, 10),
      rect(20, 200, 30, 14),
    ], 100, 100),
    rect(20, 200, 30, 14),
  );
  assert.equal(pickSelectionAnchorRect([rect(0, 0, 0, 0)], 100, 100), null);
});

test('maps iframe client coordinates through its rendered scale and offset', () => {
  const frame = {
    rect: rect(100, 50, 400, 300),
    clientWidth: 200,
    clientHeight: 150,
  };
  assert.deepEqual(mapFrameClientPoint({ x: 25, y: 30 }, frame), { x: 150, y: 110 });
  assert.deepEqual(mapFrameClientPoint({ x: 25, y: 30 }, null), { x: 25, y: 30 });
});

test('maps a selected range to a parent viewport menu anchor', () => {
  const frame = {
    rect: rect(20, 40, 300, 200),
    clientWidth: 300,
    clientHeight: 200,
  };
  assert.deepEqual(
    mapSelectionRectToViewport(rect(30, 50, 80, 20), frame),
    { x: 90, top: 90, bottom: 110 },
  );
});

test('uses a small hit slop for finger taps near a highlight without matching distant text', () => {
  const highlight = rect(40, 60, 80, 20);
  assert.equal(isPointInsideRects([highlight], { x: 70, y: 70 }, 6), true);
  assert.equal(isPointInsideRects([highlight], { x: 35, y: 70 }, 6), true);
  assert.equal(isPointInsideRects([highlight], { x: 33, y: 70 }, 6), false);
  assert.equal(isPointInsideRects([highlight], { x: 70, y: 87 }, 6), false);
});

test('maps an iframe range rect before testing parent viewport visibility', () => {
  const frame = {
    rect: rect(100, -200, 400, 600),
    clientWidth: 200,
    clientHeight: 300,
  };
  assert.deepEqual(
    mapFrameRectToViewport(rect(10, 120, 30, 20), frame),
    rect(120, 40, 60, 40),
  );
});

test('requires a non-collapsed selection with actual text', () => {
  const selection = (isCollapsed, text, rangeCount = 1) => ({
    isCollapsed,
    rangeCount,
    toString: () => text,
  });
  assert.equal(hasNonCollapsedSelection(selection(false, ' selected ')), true);
  assert.equal(hasNonCollapsedSelection(selection(true, 'selected')), false);
  assert.equal(hasNonCollapsedSelection(selection(false, '   ')), false);
  assert.equal(hasNonCollapsedSelection(selection(false, 'selected', 0)), false);
  assert.equal(hasNonCollapsedSelection(null), false);
});

test('classifies only short stationary pointer gestures as reader taps', () => {
  assert.equal(isShortReaderTapGesture({ durationMs: 120, distancePx: 4 }), true);
  assert.equal(isShortReaderTapGesture({ durationMs: 420, distancePx: 4 }), false);
  assert.equal(isShortReaderTapGesture({ durationMs: 120, distancePx: 24 }), false);
});

test('recognizes a rapid same-area navigation tap across page relocation', () => {
  const previous = { x: 120, y: 80, at: 1_000 };
  assert.equal(isRapidReaderNavigationTap(previous, { x: 128, y: 86 }, 1_420), true);
  assert.equal(isRapidReaderNavigationTap(previous, { x: 128, y: 86 }, 1_800), false);
  assert.equal(isRapidReaderNavigationTap(previous, { x: 260, y: 80 }, 1_420), false);
  assert.equal(isRapidReaderNavigationTap(null, { x: 120, y: 80 }, 1_420), false);
});

test('recognizes publication links without relying on same-realm instanceof', () => {
  const crossRealmLikeAnchor = {
    closest: (selector) => selector === 'a[href]' ? { href: '#chapter' } : null,
  };
  assert.equal(isPublicationLinkTarget(crossRealmLikeAnchor), true);
  assert.equal(isPublicationLinkTarget({ closest: () => null }), false);
  assert.equal(isPublicationLinkTarget(null), false);
});

test('recognizes only Foliate relocations caused by selection movement', () => {
  assert.equal(isSelectionRelocateReason('selection'), true);
  assert.equal(isSelectionRelocateReason('selection-page'), true);
  assert.equal(isSelectionRelocateReason('selection-anchor'), true);
  assert.equal(isSelectionRelocateReason('page'), false);
  assert.equal(isSelectionRelocateReason('anchor'), false);
  assert.equal(isSelectionRelocateReason(undefined), false);
});
