'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hasNonCollapsedSelection,
  getDocumentFrameMetrics,
  getRangeTextContext,
  getRangeViewportAnchor,
  isRapidReaderNavigationTap,
  isShortReaderTapGesture,
  isPublicationLinkTarget,
  mapFrameClientPoint,
  type SelectionViewportAnchor,
  type ReaderNavigationTap,
} from '../../lib/readerTextSelection';

export type ReaderTextSelection = SelectionViewportAnchor & {
  text: string;
  range: Range;
  index: number;
  prefix: string;
  suffix: string;
};

type DocumentTapHandler = (point: { x: number; y: number }) => boolean;

interface UseReaderTextSelectionOptions {
  enabled: boolean;
  onDocumentTap: DocumentTapHandler;
}

type DocumentBinding = {
  cleanup: () => void;
  frameRequest: number | null;
  index: number;
  pointerGesture: {
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    maxDistance: number;
  } | null;
  selectionGesture: boolean;
  suppressNextClick: boolean;
};

const installSelectionStyles = (doc: Document) => {
  const existing = doc.querySelector<HTMLStyleElement>('style[data-reader-text-selection]');
  if (existing) return existing;

  const style = doc.createElement('style');
  style.dataset.readerTextSelection = 'true';
  style.textContent = `
    html, body {
      -webkit-user-select: text !important;
      user-select: text !important;
      -webkit-touch-callout: none !important;
      touch-action: manipulation;
    }
    a[href] {
      -webkit-touch-callout: default;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
  return style;
};

const fallbackCopy = (text: string) => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  Object.assign(textarea.style, {
    position: 'fixed',
    left: '-9999px',
    top: '0',
    opacity: '0',
  });
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('copy command failed');
};

export const useReaderTextSelection = ({
  enabled,
  onDocumentTap,
}: UseReaderTextSelectionOptions) => {
  const [selection, setSelection] = useState<ReaderTextSelection | null>(null);
  const [feedback, setFeedback] = useState('');
  const bindingsRef = useRef(new Map<Document, DocumentBinding>());
  const activeDocumentRef = useRef<Document | null>(null);
  const hasSelectionRef = useRef(false);
  const lastNavigationTapRef = useRef<ReaderNavigationTap | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);

  const showFeedback = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setFeedback('');
    }, 1800);
  }, []);

  const resetBindingGesture = useCallback((doc: Document | null) => {
    if (!doc) return;
    const binding = bindingsRef.current.get(doc);
    if (!binding) return;
    binding.selectionGesture = false;
    binding.suppressNextClick = false;
  }, []);

  const clearSelection = useCallback(() => {
    const doc = activeDocumentRef.current;
    try {
      doc?.getSelection()?.removeAllRanges();
    } catch {
      // A frame may have been replaced while the selection was active.
    }
    resetBindingGesture(doc);
    activeDocumentRef.current = null;
    hasSelectionRef.current = false;
    setSelection(null);
    setFeedback('');
  }, [resetBindingGesture]);

  const dismissMenu = useCallback(() => {
    setSelection(null);
    setFeedback('');
  }, []);

  const readSelection = useCallback((doc: Document) => {
    if (!enabled) return;
    const current = doc.getSelection();
    if (!hasNonCollapsedSelection(current)) {
      if (activeDocumentRef.current === doc) {
        activeDocumentRef.current = null;
        hasSelectionRef.current = false;
        setSelection(null);
      }
      return;
    }

    const range = current!.getRangeAt(0).cloneRange();
    if (!doc.documentElement.contains(range.commonAncestorContainer)) return;

    const anchor = getRangeViewportAnchor(
      range,
      getDocumentFrameMetrics(doc),
      window.innerWidth,
      window.innerHeight,
    );
    if (!anchor) return;
    const binding = bindingsRef.current.get(doc);
    if (!binding) return;
    const context = getRangeTextContext(range, doc.body || doc.documentElement);

    const previousDocument = activeDocumentRef.current;
    if (previousDocument && previousDocument !== doc) {
      try {
        previousDocument.getSelection()?.removeAllRanges();
      } catch {
        // Ignore a stale replaced frame.
      }
      resetBindingGesture(previousDocument);
    }

    activeDocumentRef.current = doc;
    hasSelectionRef.current = true;
    setSelection({
      text: range.toString(),
      range,
      index: binding.index,
      ...context,
      ...anchor,
    });
  }, [enabled, resetBindingGesture]);

  const scheduleRead = useCallback((doc: Document) => {
    const binding = bindingsRef.current.get(doc);
    if (!binding || binding.frameRequest !== null) return;
    const view = doc.defaultView;
    const requestFrame = view?.requestAnimationFrame.bind(view) ?? window.requestAnimationFrame.bind(window);
    binding.frameRequest = requestFrame(() => {
      binding.frameRequest = null;
      readSelection(doc);
    });
  }, [readSelection]);

  const bindDocument = useCallback((doc: Document, index = -1) => {
    if (!enabled || bindingsRef.current.has(doc)) return;
    const style = installSelectionStyles(doc);
    const binding: DocumentBinding = {
      cleanup: () => undefined,
      frameRequest: null,
      index,
      pointerGesture: null,
      selectionGesture: false,
      suppressNextClick: false,
    };

    const handleSelectionChange = () => {
      if (hasNonCollapsedSelection(doc.getSelection())) {
        binding.selectionGesture = true;
      }
      scheduleRead(doc);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.button !== 0
        || (binding.pointerGesture && binding.pointerGesture.pointerId !== event.pointerId)
      ) return;
      binding.suppressNextClick = false;
      binding.pointerGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: event.timeStamp,
        maxDistance: 0,
      };
      if (hasNonCollapsedSelection(doc.getSelection())) {
        binding.suppressNextClick = true;
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      const gesture = binding.pointerGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gesture.maxDistance = Math.max(
        gesture.maxDistance,
        Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY),
      );
    };
    const resetPointerGesture = (event: PointerEvent) => {
      if (binding.pointerGesture?.pointerId === event.pointerId) {
        binding.pointerGesture = null;
      }
    };
    const clearRapidTapSelection = () => {
      try {
        doc.getSelection()?.removeAllRanges();
      } catch {
        // Ignore a selection whose publication frame was replaced mid-gesture.
      }
      resetBindingGesture(doc);
      activeDocumentRef.current = null;
      hasSelectionRef.current = false;
      setSelection(null);
      setFeedback('');
    };
    const handlePointerUp = (event: PointerEvent) => {
      const gesture = binding.pointerGesture;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        scheduleRead(doc);
        return;
      }
      binding.pointerGesture = null;

      if (event.defaultPrevented || isPublicationLinkTarget(event.target)) {
        lastNavigationTapRef.current = null;
        scheduleRead(doc);
        return;
      }

      const point = mapFrameClientPoint(
        { x: event.clientX, y: event.clientY },
        getDocumentFrameMetrics(doc),
      );
      const now = performance.now();
      const activeSelection = hasNonCollapsedSelection(doc.getSelection());
      const rapidNavigationContinuation = activeSelection
        && isRapidReaderNavigationTap(lastNavigationTapRef.current, point, now);
      const shortTap = isShortReaderTapGesture({
        durationMs: event.timeStamp - gesture.startTime,
        distancePx: gesture.maxDistance,
      });

      if (!shortTap && !rapidNavigationContinuation) {
        scheduleRead(doc);
        return;
      }
      if (activeSelection && !rapidNavigationContinuation) {
        scheduleRead(doc);
        return;
      }
      if (rapidNavigationContinuation) clearRapidTapSelection();

      event.preventDefault();
      event.stopPropagation();
      binding.selectionGesture = false;
      binding.suppressNextClick = true;
      const navigated = onDocumentTap(point);
      lastNavigationTapRef.current = navigated ? { ...point, at: now } : null;
      scheduleRead(doc);
    };
    const handleTouchEnd = () => scheduleRead(doc);
    const handleContextMenu = (event: Event) => {
      if (
        activeDocumentRef.current !== doc
        && !hasNonCollapsedSelection(doc.getSelection())
      ) return;
      event.preventDefault();
    };
    const handleScroll = () => {
      if (activeDocumentRef.current === doc) dismissMenu();
    };
    const handleClick = (event: MouseEvent) => {
      if (binding.suppressNextClick) {
        event.preventDefault();
        event.stopImmediatePropagation();
        binding.suppressNextClick = false;
        return;
      }
      const active = hasNonCollapsedSelection(doc.getSelection());
      if (binding.selectionGesture || active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        binding.selectionGesture = false;
        scheduleRead(doc);
        return;
      }

      if (event.defaultPrevented || isPublicationLinkTarget(event.target)) return;
      const point = mapFrameClientPoint(
        { x: event.clientX, y: event.clientY },
        getDocumentFrameMetrics(doc),
      );
      queueMicrotask(() => {
        if (!event.defaultPrevented) {
          const now = performance.now();
          const navigated = onDocumentTap(point);
          lastNavigationTapRef.current = navigated ? { ...point, at: now } : null;
        }
      });
    };

    const cleanup = () => {
      doc.removeEventListener('selectionchange', handleSelectionChange);
      doc.removeEventListener('pointerdown', handlePointerDown, true);
      doc.removeEventListener('pointermove', handlePointerMove, true);
      doc.removeEventListener('pointerup', handlePointerUp, true);
      doc.removeEventListener('pointercancel', resetPointerGesture, true);
      doc.removeEventListener('touchend', handleTouchEnd, true);
      doc.removeEventListener('contextmenu', handleContextMenu, true);
      doc.removeEventListener('scroll', handleScroll, true);
      doc.removeEventListener('click', handleClick, true);
      doc.defaultView?.removeEventListener('unload', cleanup);
      if (binding.frameRequest !== null) {
        doc.defaultView?.cancelAnimationFrame(binding.frameRequest);
      }
      style.remove();
      bindingsRef.current.delete(doc);
      if (activeDocumentRef.current === doc) {
        activeDocumentRef.current = null;
        hasSelectionRef.current = false;
        setSelection(null);
      }
    };

    binding.cleanup = cleanup;
    bindingsRef.current.set(doc, binding);
    doc.addEventListener('selectionchange', handleSelectionChange);
    doc.addEventListener('pointerdown', handlePointerDown, true);
    doc.addEventListener('pointermove', handlePointerMove, true);
    doc.addEventListener('pointerup', handlePointerUp, true);
    doc.addEventListener('pointercancel', resetPointerGesture, true);
    doc.addEventListener('touchend', handleTouchEnd, true);
    doc.addEventListener('contextmenu', handleContextMenu, true);
    doc.addEventListener('scroll', handleScroll, true);
    doc.addEventListener('click', handleClick, true);
    doc.defaultView?.addEventListener('unload', cleanup, { once: true });
  }, [dismissMenu, enabled, onDocumentTap, resetBindingGesture, scheduleRead]);

  const copySelection = useCallback(async () => {
    const text = selection?.text;
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showFeedback('복사됨');
    } catch (error) {
      console.warn('[EpubReader] Failed to copy selected text:', error);
      showFeedback('복사 실패');
    }
  }, [selection?.text, showFeedback]);

  const shareSelection = useCallback(async () => {
    const text = selection?.text;
    if (!text || typeof navigator.share !== 'function') return;
    try {
      await navigator.share({ text });
      showFeedback('공유됨');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.warn('[EpubReader] Failed to share selected text:', error);
      showFeedback('공유 실패');
    }
  }, [selection?.text, showFeedback]);

  useEffect(() => {
    if (enabled) return;
    for (const binding of [...bindingsRef.current.values()]) binding.cleanup();
    activeDocumentRef.current = null;
    hasSelectionRef.current = false;
  }, [enabled]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    for (const binding of [...bindingsRef.current.values()]) binding.cleanup();
  }, []);

  return {
    selection: enabled ? selection : null,
    feedback,
    canShare: typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    hasSelectionRef,
    bindDocument,
    clearSelection,
    dismissMenu,
    copySelection,
    shareSelection,
  };
};
