'use client';

import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

// All menu surfaces, including those outside ReaderModalFrame, use the same
// header gesture. Only mobile bottom sheets opt in through data-menu-sheet.
export const useMenuSheetDrag = (onClose: () => void, disabled = false) => {
  const drag = useRef<{
    id: number; x: number; y: number; started: number; distance: number;
    sheet: HTMLElement; header: HTMLElement;
  } | null>(null);

  const reset = () => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    current.sheet.removeAttribute('data-sheet-dragging');
    current.sheet.style.removeProperty('--sheet-drag-y');
    if (current.header.hasPointerCapture(current.id)) current.header.releasePointerCapture(current.id);
  };

  useEffect(() => () => reset(), []);

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (disabled || !event.isPrimary || event.button !== 0
        || !window.matchMedia('(max-width: 639px)').matches
        || (event.target as HTMLElement).closest('button, a, input, select, textarea, [role="button"]')) return;
      const sheet = event.currentTarget.closest<HTMLElement>('[data-menu-sheet="true"]');
      if (!sheet) return;
      reset();
      drag.current = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        started: event.timeStamp, distance: 0, sheet, header: event.currentTarget,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      if (disabled || !window.matchMedia('(max-width: 639px)').matches) { reset(); return; }
      const dy = event.clientY - current.y;
      if (Math.abs(event.clientX - current.x) > Math.max(12, Math.abs(dy))) { reset(); return; }
      current.distance = Math.max(0, dy);
      current.sheet.setAttribute('data-sheet-dragging', 'true');
      current.sheet.style.setProperty('--sheet-drag-y', `${current.distance}px`);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      const distance = current.distance;
      const speed = distance / Math.max(1, event.timeStamp - current.started);
      reset();
      if (!disabled && window.matchMedia('(max-width: 639px)').matches
        && (distance >= 64 || (distance >= 24 && speed >= 0.65))) onClose();
    },
    onPointerCancel: reset,
    onLostPointerCapture: reset,
  };
};
