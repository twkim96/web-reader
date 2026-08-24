'use client';

import { MutableRefObject } from 'react';
import { FoliateViewElement } from './types';

type BoundaryTouchGesture = {
  identifier: number;
  startY: number;
  startedAtTop: boolean;
  startedAtBottom: boolean;
  cancelled: boolean;
};

const activeBoundaryCleanups = new WeakMap<Document, () => void>();

const findTouch = (touches: TouchList, identifier: number) => {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return null;
};

export const installScrollBoundaryNavigation = (
  viewRef: MutableRefObject<FoliateViewElement | null>,
  doc: Document,
) => {
  activeBoundaryCleanups.get(doc)?.();

  let wheelAccumulator = 0;
  let lastWheelTime = 0;
  let touchGesture: BoundaryTouchGesture | null = null;

  const handleWheel = (ev: WheelEvent) => {
    const viewEl = viewRef.current;
    if (!viewEl?.renderer || viewEl.renderer.getAttribute('flow') !== 'scrolled') return;
    const renderer = viewEl.renderer;

    const now = Date.now();
    if (now - lastWheelTime > 300) wheelAccumulator = 0;
    lastWheelTime = now;

    const scrollPos = renderer.start;
    const totalSize = renderer.viewSize;
    const viewportSize = renderer.size;

    if (scrollPos <= 0 && ev.deltaY < 0) {
      wheelAccumulator += Math.abs(ev.deltaY);
      if (wheelAccumulator > 150) {
        wheelAccumulator = 0;
        viewEl.prev();
      }
    } else if (scrollPos + viewportSize >= totalSize - 5 && ev.deltaY > 0) {
      wheelAccumulator += ev.deltaY;
      if (wheelAccumulator > 150) {
        wheelAccumulator = 0;
        viewEl.next();
      }
    } else {
      wheelAccumulator = 0;
    }
  };

  const handleTouchStart = (ev: TouchEvent) => {
    const viewEl = viewRef.current;
    if (
      ev.touches.length !== 1
      || !viewEl?.renderer
      || viewEl.renderer.getAttribute('flow') !== 'scrolled'
    ) {
      touchGesture = null;
      return;
    }
    const touch = ev.touches[0];
    if (!touch) {
      touchGesture = null;
      return;
    }
    const renderer = viewEl.renderer;
    const scrollPos = renderer.start;
    touchGesture = {
      identifier: touch.identifier,
      startY: touch.clientY,
      startedAtTop: scrollPos <= 5,
      startedAtBottom: scrollPos + renderer.size >= renderer.viewSize - 15,
      cancelled: false,
    };
  };

  const handleTouchMove = (ev: TouchEvent) => {
    if (!touchGesture) return;
    if (
      ev.touches.length !== 1
      || !findTouch(ev.touches, touchGesture.identifier)
    ) {
      touchGesture.cancelled = true;
    }
  };

  const handleTouchEnd = (ev: TouchEvent) => {
    const gesture = touchGesture;
    touchGesture = null;
    if (!gesture || gesture.cancelled || ev.touches.length !== 0) return;

    const viewEl = viewRef.current;
    if (!viewEl?.renderer || viewEl.renderer.getAttribute('flow') !== 'scrolled') return;
    const touch = findTouch(ev.changedTouches, gesture.identifier);
    if (!touch) return;

    const renderer = viewEl.renderer;
    const deltaY = gesture.startY - touch.clientY;
    const scrollPos = renderer.start;
    const endedAtTop = scrollPos <= 5;
    const endedAtBottom = scrollPos + renderer.size >= renderer.viewSize - 15;

    if (gesture.startedAtTop && endedAtTop && deltaY < -60) {
      viewEl.prev();
    } else if (gesture.startedAtBottom && endedAtBottom && deltaY > 60) {
      viewEl.next();
    }
  };

  const handleTouchCancel = () => {
    touchGesture = null;
  };

  const cleanup = () => {
    doc.removeEventListener('wheel', handleWheel);
    doc.removeEventListener('touchstart', handleTouchStart);
    doc.removeEventListener('touchmove', handleTouchMove);
    doc.removeEventListener('touchend', handleTouchEnd);
    doc.removeEventListener('touchcancel', handleTouchCancel);
    doc.defaultView?.removeEventListener('unload', cleanup);
    if (activeBoundaryCleanups.get(doc) === cleanup) {
      activeBoundaryCleanups.delete(doc);
    }
  };

  doc.addEventListener('wheel', handleWheel, { passive: true });
  doc.addEventListener('touchstart', handleTouchStart, { passive: true });
  doc.addEventListener('touchmove', handleTouchMove, { passive: true });
  doc.addEventListener('touchend', handleTouchEnd, { passive: true });
  doc.addEventListener('touchcancel', handleTouchCancel, { passive: true });
  doc.defaultView?.addEventListener('unload', cleanup, { once: true });
  activeBoundaryCleanups.set(doc, cleanup);
  return cleanup;
};
