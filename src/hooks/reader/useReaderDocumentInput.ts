'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

type ReaderDocumentInputOptions = {
  scrollMode: boolean;
  controlsVisible: boolean;
  hasSelectionRef: MutableRefObject<boolean>;
  onWheel: (event: WheelEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  markUserInteraction: () => void;
  markUserProgressChange: () => void;
};

const TOUCH_PROGRESS_THRESHOLD_PX = 8;

type TrackedTouchGesture = {
  identifier: number;
  startX: number;
  startY: number;
  progressMarked: boolean;
};

const findTrackedTouch = (touches: TouchList, identifier: number) => {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return null;
};

export const getReaderDocumentInputPolicy = (
  scrollMode: boolean,
  controlsVisible: boolean,
) => ({
  wheelPassive: scrollMode,
  blockTouchMove: controlsVisible,
});

export const useReaderDocumentInput = ({
  scrollMode,
  controlsVisible,
  hasSelectionRef,
  onWheel,
  onKeyDown,
  markUserInteraction,
  markUserProgressChange,
}: ReaderDocumentInputOptions) => {
  const documentsRef = useRef(new Set<Document>());
  const bindingCleanupsRef = useRef(new Map<Document, () => void>());
  const unloadCleanupsRef = useRef(new Map<Document, () => void>());
  const markUserInteractionRef = useRef(markUserInteraction);
  const markUserProgressChangeRef = useRef(markUserProgressChange);
  const onWheelRef = useRef(onWheel);
  const onKeyDownRef = useRef(onKeyDown);

  useEffect(() => {
    markUserInteractionRef.current = markUserInteraction;
    markUserProgressChangeRef.current = markUserProgressChange;
    onWheelRef.current = onWheel;
    onKeyDownRef.current = onKeyDown;
  }, [markUserInteraction, markUserProgressChange, onKeyDown, onWheel]);

  const bindDocumentInput = useCallback((doc: Document) => {
    bindingCleanupsRef.current.get(doc)?.();

    const policy = getReaderDocumentInputPolicy(scrollMode, controlsVisible);
    let touchGesture: TrackedTouchGesture | null = null;
    const handleWheel = (event: WheelEvent) => onWheelRef.current(event);
    const handleTouchStart = (event: TouchEvent) => {
      markUserInteractionRef.current();
      if (hasSelectionRef.current || event.touches.length !== 1) {
        touchGesture = null;
        return;
      }
      const touch = event.touches[0];
      touchGesture = touch ? {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        progressMarked: false,
      } : null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (hasSelectionRef.current) {
        touchGesture = null;
        return;
      }
      if (policy.blockTouchMove) {
        touchGesture = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!touchGesture || event.touches.length !== 1) {
        touchGesture = null;
        return;
      }
      const touch = findTrackedTouch(event.touches, touchGesture.identifier);
      if (!touch) {
        touchGesture = null;
        return;
      }
      if (
        !touchGesture.progressMarked
        && Math.hypot(
          touch.clientX - touchGesture.startX,
          touch.clientY - touchGesture.startY,
        ) >= TOUCH_PROGRESS_THRESHOLD_PX
      ) {
        touchGesture.progressMarked = true;
        markUserProgressChangeRef.current();
      }
    };
    const clearTouchGesture = () => {
      touchGesture = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => onKeyDownRef.current(event);

    doc.addEventListener('wheel', handleWheel, { passive: policy.wheelPassive });
    doc.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
    doc.addEventListener('touchmove', handleTouchMove, { passive: !policy.blockTouchMove, capture: true });
    doc.addEventListener('touchend', clearTouchGesture, { passive: true, capture: true });
    doc.addEventListener('touchcancel', clearTouchGesture, { passive: true, capture: true });
    doc.addEventListener('keydown', handleKeyDown);

    const cleanup = () => {
      doc.removeEventListener('wheel', handleWheel);
      doc.removeEventListener('touchstart', handleTouchStart, true);
      doc.removeEventListener('touchmove', handleTouchMove, true);
      doc.removeEventListener('touchend', clearTouchGesture, true);
      doc.removeEventListener('touchcancel', clearTouchGesture, true);
      doc.removeEventListener('keydown', handleKeyDown);
      if (bindingCleanupsRef.current.get(doc) === cleanup) {
        bindingCleanupsRef.current.delete(doc);
      }
    };
    bindingCleanupsRef.current.set(doc, cleanup);
  }, [controlsVisible, hasSelectionRef, scrollMode]);

  useEffect(() => {
    for (const doc of documentsRef.current) bindDocumentInput(doc);
  }, [bindDocumentInput]);

  useEffect(() => () => {
    for (const cleanup of bindingCleanupsRef.current.values()) cleanup();
    for (const cleanup of unloadCleanupsRef.current.values()) cleanup();
    bindingCleanupsRef.current.clear();
    unloadCleanupsRef.current.clear();
    documentsRef.current.clear();
  }, []);

  return useCallback((doc: Document) => {
    documentsRef.current.add(doc);
    bindDocumentInput(doc);

    if (unloadCleanupsRef.current.has(doc)) return;
    const unregister = () => {
      bindingCleanupsRef.current.get(doc)?.();
      documentsRef.current.delete(doc);
      unloadCleanupsRef.current.delete(doc);
    };
    doc.defaultView?.addEventListener('unload', unregister, { once: true });
    unloadCleanupsRef.current.set(doc, () => {
      doc.defaultView?.removeEventListener('unload', unregister);
    });
  }, [bindDocumentInput]);
};
