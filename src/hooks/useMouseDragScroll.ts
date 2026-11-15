'use client';

import { useEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

// Touch and trackpad scrolling stay native. Arm mouse dragging without blocking
// a normal button click; capture the pointer only after horizontal movement.
export const useMouseDragScroll = () => {
  const drag = useRef<{
    id: number; x: number; y: number; left: number;
    element: HTMLElement; active: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const reset = () => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    current.element.removeAttribute('data-mouse-dragging');
    if (current.element.hasPointerCapture(current.id)) current.element.releasePointerCapture(current.id);
  };
  useEffect(() => () => reset(), []);

  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || !event.isPrimary) return;
      reset();
      suppressClick.current = false;
      drag.current = {
        id: event.pointerId, x: event.clientX, y: event.clientY,
        left: event.currentTarget.scrollLeft, element: event.currentTarget, active: false,
      };
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const current = drag.current;
      if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.active) {
        if (Math.abs(dy) > Math.max(6, Math.abs(dx))) { reset(); return; }
        if (Math.abs(dx) < 6) return;
        current.active = true;
        suppressClick.current = true;
        current.element.setPointerCapture(event.pointerId);
        current.element.setAttribute('data-mouse-dragging', 'true');
      }
      event.preventDefault();
      current.element.scrollLeft = current.left - dx;
    },
    onPointerUp: reset,
    onPointerCancel: reset,
    onLostPointerCapture: reset,
    onPointerLeave: () => { if (drag.current && !drag.current.active) reset(); },
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      const shouldSuppress = suppressClick.current && event.detail !== 0;
      suppressClick.current = false;
      if (!shouldSuppress) return;
      event.preventDefault();
      event.stopPropagation();
    },
  };
};
