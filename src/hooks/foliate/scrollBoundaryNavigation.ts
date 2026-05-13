'use client';

import { MutableRefObject } from 'react';
import { FoliateViewElement } from './types';

export const installScrollBoundaryNavigation = (
  viewRef: MutableRefObject<FoliateViewElement | null>,
  doc: Document
) => {
  let wheelAccumulator = 0;
  let lastWheelTime = 0;
  let touchStartY = 0;

  doc.addEventListener('wheel', (ev: WheelEvent) => {
    const viewEl = viewRef.current;
    if (!viewEl || !viewEl.renderer) return;
    const renderer = viewEl.renderer;

    if (renderer.getAttribute('flow') !== 'scrolled') return;

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
  }, { passive: true });

  doc.addEventListener('touchstart', (ev: TouchEvent) => {
    touchStartY = ev.touches[0].clientY;
  }, { passive: true });

  doc.addEventListener('touchmove', (ev: TouchEvent) => {
    const viewEl = viewRef.current;
    if (!viewEl || !viewEl.renderer) return;
    const renderer = viewEl.renderer;
    if (renderer.getAttribute('flow') !== 'scrolled') return;

    const currentY = ev.touches[0].clientY;
    const deltaY = touchStartY - currentY;
    const scrollPos = renderer.start;

    if (scrollPos <= 0 && deltaY < 0) {
      if (ev.cancelable) ev.preventDefault();
    }
  }, { passive: false });

  doc.addEventListener('touchend', (ev: TouchEvent) => {
    const viewEl = viewRef.current;
    if (!viewEl || !viewEl.renderer) return;
    const renderer = viewEl.renderer;
    if (renderer.getAttribute('flow') !== 'scrolled') return;

    const touchEndY = ev.changedTouches[0].clientY;
    const deltaY = touchStartY - touchEndY;

    const scrollPos = renderer.start;
    const totalSize = renderer.viewSize;
    const viewportSize = renderer.size;

    if (scrollPos <= 5 && deltaY < -60) {
      viewEl.prev();
    } else if (scrollPos + viewportSize >= totalSize - 15 && deltaY > 60) {
      viewEl.next();
    }
  }, { passive: true });
};
