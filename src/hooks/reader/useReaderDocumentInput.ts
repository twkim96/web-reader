'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

type ReaderDocumentInputOptions = {
  scrollMode: boolean;
  controlsVisible: boolean;
  hasSelectionRef: MutableRefObject<boolean>;
  onWheel: (event: WheelEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  markUserProgressChange: () => void;
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
  markUserProgressChange,
}: ReaderDocumentInputOptions) => {
  const documentsRef = useRef(new Set<Document>());
  const bindingCleanupsRef = useRef(new Map<Document, () => void>());
  const unloadCleanupsRef = useRef(new Map<Document, () => void>());
  const markUserProgressChangeRef = useRef(markUserProgressChange);
  const onWheelRef = useRef(onWheel);
  const onKeyDownRef = useRef(onKeyDown);

  useEffect(() => {
    markUserProgressChangeRef.current = markUserProgressChange;
    onWheelRef.current = onWheel;
    onKeyDownRef.current = onKeyDown;
  }, [markUserProgressChange, onKeyDown, onWheel]);

  const bindDocumentInput = useCallback((doc: Document) => {
    bindingCleanupsRef.current.get(doc)?.();

    const policy = getReaderDocumentInputPolicy(scrollMode, controlsVisible);
    const handleWheel = (event: WheelEvent) => onWheelRef.current(event);
    const handleTouchStart = () => {
      if (!hasSelectionRef.current) markUserProgressChangeRef.current();
    };
    const handleTouchMoveBlock = (event: TouchEvent) => {
      if (hasSelectionRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const handleKeyDown = (event: KeyboardEvent) => onKeyDownRef.current(event);

    doc.addEventListener('wheel', handleWheel, { passive: policy.wheelPassive });
    doc.addEventListener('touchstart', handleTouchStart, { passive: true, capture: true });
    if (policy.blockTouchMove) {
      doc.addEventListener('touchmove', handleTouchMoveBlock, { passive: false, capture: true });
    }
    doc.addEventListener('keydown', handleKeyDown);

    const cleanup = () => {
      doc.removeEventListener('wheel', handleWheel);
      doc.removeEventListener('touchstart', handleTouchStart, true);
      if (policy.blockTouchMove) {
        doc.removeEventListener('touchmove', handleTouchMoveBlock, true);
      }
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
