// src/components/EpubReader.tsx
'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Book, Bookmark, SaveProgressOptions, UserProgress, ViewerSettings } from '../types';
import {
  DEFAULT_LEFT_RIGHT_TAP_PERCENT,
  DEFAULT_TOP_BOTTOM_TAP_PERCENT,
  getEffectiveNavigationMode,
  getReaderKeyboardAction,
  getReaderTapAction,
} from '../lib/readerNavigation';
import { isSelectionRelocateReason } from '../lib/readerTextSelection';
import { ACCENT_PALETTE } from '../lib/constants';
import { getThemeClasses, getThemeColors, getThemeCssVariables, getThemeTextureCss } from '../lib/themeUtils';
import { SettingsModal } from './SettingsModal';
import { ThemeModal } from './ThemeModal';
import { BookmarkModal } from './BookmarkModal';
import { TocModal } from './TocModal';
import { EpubSearchModal } from './EpubSearchModal';
import { JumpDialog } from './reader/JumpDialog';
import { ProgressJumpConfirmDialog } from './reader/ProgressJumpConfirmDialog';
import { ReaderStatusBar } from './reader/ReaderStatusBar';
import { ReaderToolbar } from './reader/ReaderToolbar';
import { SyncConflictDialog } from './reader/SyncConflictDialog';
import { TextSelectionMenu } from './reader/TextSelectionMenu';
import { HighlightActionMenu } from './reader/HighlightActionMenu';
import { useEpubReader } from '../hooks/useEpubReader';
import { useReaderBookSource } from '../hooks/reader/useReaderBookSource';
import { useReaderBookmarks } from '../hooks/reader/useReaderBookmarks';
import { useReaderChrome } from '../hooks/reader/useReaderChrome';
import { useReaderProgressSave } from '../hooks/reader/useReaderProgressSave';
import { useReaderProgressSlider } from '../hooks/reader/useReaderProgressSlider';
import { useReaderTextSelection } from '../hooks/reader/useReaderTextSelection';
import { useReaderAnnotations } from '../hooks/reader/useReaderAnnotations';
import { useRemoteProgressPrompt } from '../hooks/reader/useRemoteProgressPrompt';
import type { RelocateDetail, TocItem } from '../hooks/foliate/types';
import type { OwnerKey } from '../lib/ownerIdentity';

interface EpubReaderProps {
  book: Book;
  ownerKey: OwnerKey;
  googleToken: string;
  settings: ViewerSettings;
  onUpdateSettings: (settings: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => Promise<boolean>;
  onAdoptRemoteProgress: (progress: UserProgress) => Promise<boolean>;
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  initialRevision?: number;
  remoteProgress?: UserProgress;
  resolvedRemoteProgress?: UserProgress | null;
  onRegisterProgressFlush?: (flush: (() => Promise<boolean>) | null) => void;
  onRegisterQuietResumeEligibility?: (check: (() => boolean) | null) => void;
}

const KEYBOARD_SCROLL_RATIO = 0.25;
const MIN_KEYBOARD_SCROLL_DISTANCE = 80;
const MAX_KEYBOARD_SCROLL_DISTANCE = 240;
const WHEEL_PAGE_TURN_MIN_DELTA = 8;
const WHEEL_PAGE_TURN_IDLE_MS = 220;
const FIXED_LAYOUT_ZOOM_STEP = 1.15;
const PINCH_MOVE_THRESHOLD_PX = 4;
const PAN_MOVE_THRESHOLD_PX = 6;
const MOUSE_DRAG_ZOOM_DISTANCE_PX = 220;

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  const node = target as {
    nodeType?: number;
    tagName?: string;
    isContentEditable?: boolean;
    parentElement?: HTMLElement | null;
  } | null;
  if (!node) return false;

  const element = node.nodeType === 1 ? node : node.parentElement;
  const tagName = element?.tagName?.toLowerCase();
  return Boolean(element?.isContentEditable) || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
};

const flattenTocItems = (items: TocItem[]): TocItem[] => (
  items.flatMap((item) => [item, ...flattenTocItems(item.subitems || [])])
);

const getChapterForProgress = (items: TocItem[], progressPercent: number) => {
  if (!Number.isFinite(progressPercent)) return undefined;

  const chapters = flattenTocItems(items)
    .filter((item): item is TocItem & { label: string; progress: number } => (
      Boolean(item.label) && Number.isFinite(item.progress)
    ))
    .sort((a, b) => a.progress - b.progress);

  if (chapters.length === 0) return undefined;

  let match: string | undefined;
  for (const chapter of chapters) {
    if (chapter.progress <= progressPercent + 0.05) {
      match = chapter.label;
      continue;
    }
    break;
  }

  return match;
};

const getTouchMetrics = (touches: React.TouchList) => {
  if (touches.length < 2) return null;
  const first = touches[0];
  const second = touches[1];
  const deltaX = second.clientX - first.clientX;
  const deltaY = second.clientY - first.clientY;
  return {
    distance: Math.hypot(deltaX, deltaY),
    focalPoint: {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
    },
  };
};

const getSingleTouchPoint = (touches: React.TouchList) => {
  if (touches.length !== 1) return null;
  const touch = touches[0];
  return { x: touch.clientX, y: touch.clientY };
};

const isMacLikePlatform = () => (
  typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
);

const isFixedLayoutMouseZoomModifier = (event: React.PointerEvent<HTMLDivElement>) => (
  isMacLikePlatform() ? event.metaKey : event.ctrlKey
);

const capturePointerSafely = (element: HTMLElement, pointerId: number) => {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    // Synthetic pointer events in tests may not be active pointers.
  }
};

const releasePointerCaptureSafely = (element: HTMLElement, pointerId: number) => {
  try {
    if (element.hasPointerCapture?.(pointerId)) {
      element.releasePointerCapture?.(pointerId);
    }
  } catch {
    // The browser may already have released the pointer.
  }
};

const EpubReaderInner: React.FC<EpubReaderProps> = ({
  book,
  ownerKey,
  googleToken,
  settings,
  onUpdateSettings,
  onBack,
  onSaveProgress,
  onAdoptRemoteProgress,
  initialCfi,
  initialPercent,
  initialTime,
  initialBookmarks,
  initialRevision,
  remoteProgress,
  resolvedRemoteProgress,
  onRegisterProgressFlush,
  onRegisterQuietResumeEligibility,
}) => {
  const theme = getThemeClasses(settings);
  const themeColors = useMemo(() => getThemeColors(settings), [settings]);
  const themeTexture = useMemo(() => getThemeTextureCss(settings), [settings]);
  const accentColorObj = ACCENT_PALETTE[settings.accentColor] || ACCENT_PALETTE.indigo;
  const readerShellStyle = useMemo(() => ({
    '--accent-400': accentColorObj[400],
    '--accent-500': accentColorObj[500],
    '--accent-600': accentColorObj[600],
    ...getThemeCssVariables(settings),
    backgroundColor: themeColors.bg,
    color: themeColors.text,
  }) as React.CSSProperties, [accentColorObj, settings, themeColors.bg, themeColors.text]);
  const isFixedLayout = book.readerFormat === 'archive' || book.readerFormat === 'pdf';
  const effectiveNavMode = getEffectiveNavigationMode(settings.navMode, isFixedLayout);
  const readerEdgePadding = isFixedLayout ? 0 : Math.max(settings.padding || 0, settings.fontSize);
  const suppressLastReaderSessionOnExitRef = useRef(false);
  const keyboardNavigationRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const wheelNavigationRef = useRef<(event: WheelEvent | React.WheelEvent) => void>(() => undefined);
  const documentTapRef = useRef<(point: { x: number; y: number }) => void>(() => undefined);
  const annotationMenuCloseRef = useRef<() => void>(() => undefined);
  const controlsOverlayRef = useRef<HTMLDivElement | null>(null);
  const wheelNavigationCycleLockedRef = useRef(false);
  const wheelNavigationResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinchGestureRef = useRef<{
    active: boolean;
    moved: boolean;
    startDistance: number;
    startScale: number;
  } | null>(null);
  const panGestureRef = useRef<{
    active: boolean;
    moved: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const mousePanGestureRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const mouseZoomGestureRef = useRef<{
    active: boolean;
    moved: boolean;
    pointerId: number;
    startY: number;
    startScale: number;
    focalPoint: { x: number; y: number };
  } | null>(null);
  const pendingFixedLayoutZoomRef = useRef<{
    scale: number;
    focalPoint?: { x: number; y: number };
  } | null>(null);
  const fixedLayoutZoomFrameRef = useRef<number | null>(null);
  const suppressNextInteractionClickRef = useRef(false);

  useLayoutEffect(() => {
    if (effectiveNavMode === 'scroll') return;

    const roots = [document.documentElement, document.body];
    roots.forEach((root) => root.classList.add('reader-paged-navigation'));

    return () => {
      roots.forEach((root) => root.classList.remove('reader-paged-navigation'));
    };
  }, [effectiveNavMode]);

  const handleReaderBack = useCallback(() => {
    suppressLastReaderSessionOnExitRef.current = true;
    onBack();
  }, [onBack]);

  const chrome = useReaderChrome({ onBack: handleReaderBack });
  const isReaderPanelOpen = chrome.showSettings
    || chrome.showThemeModal
    || chrome.showBookmarks
    || chrome.showToc
    || chrome.showSearchModal
    || chrome.showJumpInput;
  const isReaderPanelOpenRef = useRef(false);
  const showControlsRef = useRef(chrome.showControls);
  const {
    lastSaveTimeRef,
    updateSaveContext,
    markUserProgressChange,
    saveProgressIfChanged,
    handleRelocateForSave,
    saveCurrentProgress,
    flushCurrentProgress,
    prepareRemoteJump,
    isQuietResumeEligible,
    completeRemoteJump,
  } = useReaderProgressSave({
    initialCfi,
    initialPercent,
    initialTime,
    initialBookmarks,
    onSaveProgress,
    onAdoptRemoteProgress,
  });

  const handleDocumentTap = useCallback((point: { x: number; y: number }) => {
    documentTapRef.current(point);
  }, []);
  const {
    selection: selectedText,
    feedback: selectionFeedback,
    canShare: canShareSelection,
    hasSelectionRef,
    bindDocument: bindSelectionDocument,
    clearSelection: clearTextSelection,
    copySelection,
    shareSelection,
  } = useReaderTextSelection({
    enabled: !isFixedLayout,
    onDocumentTap: handleDocumentTap,
  });

  useEffect(() => {
    onRegisterQuietResumeEligibility?.(isQuietResumeEligible);
    return () => onRegisterQuietResumeEligibility?.(null);
  }, [isQuietResumeEligible, onRegisterQuietResumeEligibility]);

  useEffect(() => {
    onRegisterProgressFlush?.(flushCurrentProgress);
    return () => onRegisterProgressFlush?.(null);
  }, [flushCurrentProgress, onRegisterProgressFlush]);

  const handleReaderLoad = useCallback((doc?: Document, index?: number) => {
    if (!doc) return;
    bindSelectionDocument(doc, index);
    doc.addEventListener('wheel', (event) => wheelNavigationRef.current(event), { passive: false });
    doc.addEventListener('touchmove', (event) => {
      if (showControlsRef.current && !hasSelectionRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!hasSelectionRef.current) markUserProgressChange();
    }, { passive: false, capture: true });
    doc.addEventListener('keydown', (event) => keyboardNavigationRef.current(event));
  }, [bindSelectionDocument, hasSelectionRef, markUserProgressChange]);

  const handleReaderRelocate = useCallback((detail: RelocateDetail) => {
    if (!isSelectionRelocateReason(detail.reason)) {
      clearTextSelection();
      annotationMenuCloseRef.current();
    }
    handleRelocateForSave(detail);
  }, [clearTextSelection, handleRelocateForSave]);

  const {
    containerRef,
    totalProgress,
    currentCfi,
    currentAnchorCfi,
    currentChapter,
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
    viewRef,
    setStyle,
    setLayout,
    searchBook,
    clearSearch,
    toc,
  } = useEpubReader({
    initialPercent,
    onRelocate: handleReaderRelocate,
    onLoad: handleReaderLoad,
  });

  const { isLoaded } = useReaderBookSource({
    book,
    googleToken,
    initialCfi,
    settings,
    themeColors,
    themeTexture,
    containerRef,
    openBook,
    setLayout,
    setStyle,
    onBack,
  });

  const {
    activeHighlight,
    feedback: annotationFeedback,
    canUndo: canUndoAnnotation,
    createHighlight,
    changeActiveColor,
    deleteActiveHighlight,
    closeActiveHighlight,
    undoLastMutation,
  } = useReaderAnnotations({
    enabled: !isFixedLayout,
    ownerKey,
    bookId: book.id,
    viewRef,
    isLoaded,
    currentProgress: totalProgress,
    currentChapter,
    clearTextSelection,
  });

  useLayoutEffect(() => {
    annotationMenuCloseRef.current = closeActiveHighlight;
    return () => {
      annotationMenuCloseRef.current = () => undefined;
    };
  }, [closeActiveHighlight]);

  const {
    bookmarks,
    getBookmarks,
    adoptResolvedBookmarks,
    addBookmark,
    deleteBookmark,
    createAutoBookmark,
  } = useReaderBookmarks({
    initialBookmarks,
    remoteBookmarks: remoteProgress?.bookmarks,
    viewRef,
    currentCfi,
    currentAnchorCfi,
    totalProgress,
    markUserProgressChange,
    saveProgressIfChanged,
  });

  const {
    syncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  } = useRemoteProgressPrompt({
    isLoaded,
    remoteProgress,
    resolvedRemoteProgress,
    currentCfi,
    currentAnchorCfi,
    totalProgress,
    localRevision: initialRevision,
    lastSaveTimeRef,
    goTo,
    getBookmarks,
    adoptResolvedBookmarks,
    createAutoBookmark,
    prepareRemoteJump,
    isQuietResumeEligible,
    completeRemoteJump,
  });

  const {
    sliderProgress,
    isSliderPreviewing,
    pendingSliderMove,
    beginSliderMove,
    previewSliderMove,
    commitSliderMove,
    cancelSliderMove,
    confirmSliderMove,
  } = useReaderProgressSlider({
    currentCfi,
    totalProgress,
    createAutoBookmark,
    markUserProgressChange,
    goToFraction,
  });

  const sliderTargetChapter = useMemo(
    () => getChapterForProgress(toc, sliderProgress),
    [sliderProgress, toc]
  );
  const pendingSliderTargetChapter = useMemo(
    () => pendingSliderMove ? getChapterForProgress(toc, pendingSliderMove.targetPercent) : undefined,
    [pendingSliderMove, toc]
  );

  useLayoutEffect(() => {
    isReaderPanelOpenRef.current = isReaderPanelOpen;
  }, [isReaderPanelOpen]);

  useLayoutEffect(() => {
    showControlsRef.current = chrome.showControls;
  }, [chrome.showControls]);

  useEffect(() => {
    if (isReaderPanelOpen) {
      clearTextSelection();
      closeActiveHighlight();
    }
  }, [clearTextSelection, closeActiveHighlight, isReaderPanelOpen]);

  useEffect(() => {
    if (selectedText) closeActiveHighlight();
  }, [closeActiveHighlight, selectedText]);

  useEffect(() => {
    updateSaveContext({
      currentCfi,
      currentAnchorCfi,
      totalProgress,
      bookmarks,
      hasSyncConflict: Boolean(syncConflict),
    });
  }, [bookmarks, currentAnchorCfi, currentCfi, syncConflict, totalProgress, updateSaveContext]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentProgress();
      }
    };

    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      saveCurrentProgress(
        suppressLastReaderSessionOnExitRef.current
          ? { suppressLastReaderSession: true }
          : undefined
      );
    };
  }, [saveCurrentProgress]);

  const handleInteractionAtPoint = useCallback(({ x, y }: { x: number; y: number }) => {
    if (hasSelectionRef.current) return;
    if (chrome.showControls) {
      chrome.setShowControls(false);
      return;
    }
    const action = getReaderTapAction({
      navMode: effectiveNavMode,
      clientX: x,
      clientY: y,
      width: window.innerWidth,
      height: window.innerHeight,
      topBottomPercent: settings.tapTopBottomPercent ?? DEFAULT_TOP_BOTTOM_TAP_PERCENT,
      leftRightPercent: settings.tapLeftRightPercent ?? DEFAULT_LEFT_RIGHT_TAP_PERCENT,
    });

    if (action !== 'controls') {
      markUserProgressChange();
      if (action === 'prev') prev();
      else next();
      return;
    }

    chrome.setShowControls((current) => !current);
  }, [
    chrome,
    effectiveNavMode,
    markUserProgressChange,
    next,
    prev,
    settings.tapLeftRightPercent,
    settings.tapTopBottomPercent,
    hasSelectionRef,
  ]);

  useLayoutEffect(() => {
    documentTapRef.current = handleInteractionAtPoint;
  }, [handleInteractionAtPoint]);

  const handleInteraction = useCallback((event: React.MouseEvent) => {
    if (suppressNextInteractionClickRef.current) {
      suppressNextInteractionClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    handleInteractionAtPoint({ x: event.clientX, y: event.clientY });
  }, [handleInteractionAtPoint]);

  const getFixedLayoutRenderer = useCallback(() => {
    const renderer = viewRef.current?.renderer;
    if (!isFixedLayout || !renderer?.setUserScale) return null;
    return renderer;
  }, [isFixedLayout, viewRef]);

  const adjustFixedLayoutZoom = useCallback((
    factor: number,
    focalPoint?: { x: number; y: number },
  ) => {
    const renderer = getFixedLayoutRenderer();
    if (!renderer) return false;
    renderer.adjustUserScale?.(factor, focalPoint);
    return true;
  }, [getFixedLayoutRenderer]);

  const setFixedLayoutZoom = useCallback((
    scale: number,
    focalPoint?: { x: number; y: number },
    options?: { preview?: boolean },
  ) => {
    const renderer = getFixedLayoutRenderer();
    if (!renderer) return false;
    renderer.setUserScale?.(scale, focalPoint, options);
    return true;
  }, [getFixedLayoutRenderer]);

  const commitFixedLayoutZoom = useCallback(() => {
    const renderer = getFixedLayoutRenderer();
    if (!renderer) return false;
    renderer.commitUserScale?.();
    return true;
  }, [getFixedLayoutRenderer]);

  const flushPendingFixedLayoutZoom = useCallback((options?: { preview?: boolean }) => {
    const pendingZoom = pendingFixedLayoutZoomRef.current;
    pendingFixedLayoutZoomRef.current = null;
    if (!pendingZoom) return false;
    setFixedLayoutZoom(pendingZoom.scale, pendingZoom.focalPoint, options);
    return true;
  }, [setFixedLayoutZoom]);

  const scheduleFixedLayoutZoom = useCallback((
    scale: number,
    focalPoint?: { x: number; y: number },
  ) => {
    pendingFixedLayoutZoomRef.current = { scale, focalPoint };
    if (fixedLayoutZoomFrameRef.current !== null) return;
    fixedLayoutZoomFrameRef.current = window.requestAnimationFrame(() => {
      fixedLayoutZoomFrameRef.current = null;
      flushPendingFixedLayoutZoom({ preview: true });
    });
  }, [flushPendingFixedLayoutZoom]);

  const handleFixedLayoutTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!isFixedLayout) return;
    const renderer = getFixedLayoutRenderer();
    if (!renderer) return;

    const metrics = getTouchMetrics(event.touches);
    if (metrics) {
      panGestureRef.current = null;
      event.preventDefault();
      event.stopPropagation();
      pinchGestureRef.current = {
        active: true,
        moved: false,
        startDistance: metrics.distance,
        startScale: renderer.userScale ?? 1,
      };
      return;
    }

    const touchPoint = getSingleTouchPoint(event.touches);
    if (!touchPoint || (renderer.userScale ?? 1) <= 1 || !renderer.panBy) return;

    panGestureRef.current = {
      active: true,
      moved: false,
      startX: touchPoint.x,
      startY: touchPoint.y,
      lastX: touchPoint.x,
      lastY: touchPoint.y,
    };
  }, [getFixedLayoutRenderer, isFixedLayout]);

  const handleFixedLayoutTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = pinchGestureRef.current;
    if (gesture?.active) {
      const metrics = getTouchMetrics(event.touches);
      if (!metrics || gesture.startDistance <= 0) return;

      event.preventDefault();
      event.stopPropagation();
      if (Math.abs(metrics.distance - gesture.startDistance) >= PINCH_MOVE_THRESHOLD_PX) {
        gesture.moved = true;
        suppressNextInteractionClickRef.current = true;
      }
      scheduleFixedLayoutZoom(
        gesture.startScale * (metrics.distance / gesture.startDistance),
        metrics.focalPoint,
      );
      return;
    }

    const panGesture = panGestureRef.current;
    if (!panGesture?.active) return;
    const touchPoint = getSingleTouchPoint(event.touches);
    const renderer = getFixedLayoutRenderer();
    if (!touchPoint || !renderer?.panBy || (renderer.userScale ?? 1) <= 1) return;

    const movedDistance = Math.hypot(touchPoint.x - panGesture.startX, touchPoint.y - panGesture.startY);
    if (!panGesture.moved && movedDistance < PAN_MOVE_THRESHOLD_PX) return;

    panGesture.moved = true;
    suppressNextInteractionClickRef.current = true;
    event.preventDefault();
    event.stopPropagation();
    renderer.panBy(panGesture.lastX - touchPoint.x, panGesture.lastY - touchPoint.y);
    panGesture.lastX = touchPoint.x;
    panGesture.lastY = touchPoint.y;
  }, [getFixedLayoutRenderer, scheduleFixedLayoutZoom]);

  const handleFixedLayoutTouchEnd = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = pinchGestureRef.current;
    if (gesture?.active && event.touches.length < 2) {
      if (fixedLayoutZoomFrameRef.current !== null) {
        window.cancelAnimationFrame(fixedLayoutZoomFrameRef.current);
        fixedLayoutZoomFrameRef.current = null;
      }
      const committedPendingZoom = flushPendingFixedLayoutZoom();
      if (!committedPendingZoom) {
        commitFixedLayoutZoom();
      }
      if (gesture.moved) {
        suppressNextInteractionClickRef.current = true;
      }
      pinchGestureRef.current = null;

      const touchPoint = getSingleTouchPoint(event.touches);
      const renderer = getFixedLayoutRenderer();
      if (touchPoint && renderer?.panBy && (renderer.userScale ?? 1) > 1) {
        panGestureRef.current = {
          active: true,
          moved: false,
          startX: touchPoint.x,
          startY: touchPoint.y,
          lastX: touchPoint.x,
          lastY: touchPoint.y,
        };
        return;
      }
    }

    const panGesture = panGestureRef.current;
    if (panGesture?.active && event.touches.length === 0) {
      if (panGesture.moved) {
        suppressNextInteractionClickRef.current = true;
      }
      panGestureRef.current = null;
    }
  }, [commitFixedLayoutZoom, flushPendingFixedLayoutZoom, getFixedLayoutRenderer]);

  const finishFixedLayoutMouseZoomGesture = useCallback((
    event?: React.PointerEvent<HTMLDivElement>,
  ) => {
    const zoomGesture = mouseZoomGestureRef.current;
    if (!zoomGesture || (event && zoomGesture.pointerId !== event.pointerId)) return false;

    if (fixedLayoutZoomFrameRef.current !== null) {
      window.cancelAnimationFrame(fixedLayoutZoomFrameRef.current);
      fixedLayoutZoomFrameRef.current = null;
    }
    const committedPendingZoom = flushPendingFixedLayoutZoom();
    if (!committedPendingZoom && zoomGesture.moved) {
      commitFixedLayoutZoom();
    }
    suppressNextInteractionClickRef.current = true;
    mouseZoomGestureRef.current = null;

    if (event) {
      event.preventDefault();
      event.stopPropagation();
      releasePointerCaptureSafely(event.currentTarget, event.pointerId);
    }

    return true;
  }, [commitFixedLayoutZoom, flushPendingFixedLayoutZoom]);

  const handleFixedLayoutPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isFixedLayout || event.pointerType !== 'mouse' || event.button !== 0) return;
    const renderer = getFixedLayoutRenderer();
    if (!renderer) return;

    if (isFixedLayoutMouseZoomModifier(event)) {
      mousePanGestureRef.current = null;
      mouseZoomGestureRef.current = {
        active: true,
        moved: false,
        pointerId: event.pointerId,
        startY: event.clientY,
        startScale: renderer.userScale ?? 1,
        focalPoint: { x: event.clientX, y: event.clientY },
      };
      suppressNextInteractionClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
      capturePointerSafely(event.currentTarget, event.pointerId);
      return;
    }

    if (!renderer?.panBy || (renderer.userScale ?? 1) <= 1) return;

    mouseZoomGestureRef.current = null;
    mousePanGestureRef.current = {
      active: true,
      moved: false,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
    };
    capturePointerSafely(event.currentTarget, event.pointerId);
  }, [getFixedLayoutRenderer, isFixedLayout]);

  const handleFixedLayoutPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    const zoomGesture = mouseZoomGestureRef.current;
    if (zoomGesture?.active && zoomGesture.pointerId === event.pointerId) {
      if ((event.buttons & 1) !== 1) {
        finishFixedLayoutMouseZoomGesture(event);
        return;
      }

      const renderer = getFixedLayoutRenderer();
      if (!renderer) {
        finishFixedLayoutMouseZoomGesture(event);
        return;
      }

      const deltaY = zoomGesture.startY - event.clientY;
      if (!zoomGesture.moved && Math.abs(deltaY) < PAN_MOVE_THRESHOLD_PX) return;

      zoomGesture.moved = true;
      suppressNextInteractionClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
      scheduleFixedLayoutZoom(
        zoomGesture.startScale * Math.exp(deltaY / MOUSE_DRAG_ZOOM_DISTANCE_PX),
        zoomGesture.focalPoint,
      );
      return;
    }

    const gesture = mousePanGestureRef.current;
    if (!gesture?.active || gesture.pointerId !== event.pointerId) return;

    if ((event.buttons & 1) !== 1) {
      mousePanGestureRef.current = null;
      return;
    }

    const renderer = getFixedLayoutRenderer();
    if (!renderer?.panBy || (renderer.userScale ?? 1) <= 1) {
      mousePanGestureRef.current = null;
      return;
    }

    const movedDistance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (!gesture.moved && movedDistance < PAN_MOVE_THRESHOLD_PX) return;

    gesture.moved = true;
    suppressNextInteractionClickRef.current = true;
    event.preventDefault();
    event.stopPropagation();
    renderer.panBy(gesture.lastX - event.clientX, gesture.lastY - event.clientY);
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  }, [finishFixedLayoutMouseZoomGesture, getFixedLayoutRenderer, scheduleFixedLayoutZoom]);

  const handleFixedLayoutPointerEnd = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    if (finishFixedLayoutMouseZoomGesture(event)) {
      return;
    }

    const gesture = mousePanGestureRef.current;
    if (!gesture?.active || gesture.pointerId !== event.pointerId) return;

    if (gesture.moved) {
      suppressNextInteractionClickRef.current = true;
      event.preventDefault();
      event.stopPropagation();
    }
    mousePanGestureRef.current = null;
    releasePointerCaptureSafely(event.currentTarget, event.pointerId);
  }, [finishFixedLayoutMouseZoomGesture]);

  const handleFixedLayoutLostPointerCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panGesture = mousePanGestureRef.current;
    const zoomGesture = mouseZoomGestureRef.current;
    if (event.pointerType === 'mouse' && panGesture?.pointerId === event.pointerId) {
      mousePanGestureRef.current = null;
    }
    if (event.pointerType === 'mouse' && zoomGesture?.pointerId === event.pointerId) {
      finishFixedLayoutMouseZoomGesture(event);
    }
  }, [finishFixedLayoutMouseZoomGesture]);

  const handleControlsOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressNextInteractionClickRef.current) {
      suppressNextInteractionClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    chrome.setShowControls(false);
  }, [chrome]);

  useEffect(() => {
    return () => {
      if (fixedLayoutZoomFrameRef.current !== null) {
        window.cancelAnimationFrame(fixedLayoutZoomFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (wheelNavigationResetTimerRef.current) {
        clearTimeout(wheelNavigationResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!chrome.showControls) return;
    const controlsOverlay = controlsOverlayRef.current;
    if (!controlsOverlay) return;

    const handleControlsOverlayWheel = (event: WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
    };

    controlsOverlay.addEventListener('wheel', handleControlsOverlayWheel, { passive: false });
    return () => {
      controlsOverlay.removeEventListener('wheel', handleControlsOverlayWheel);
    };
  }, [chrome.showControls]);

  useEffect(() => {
    const unlockWheelNavigationAfterIdle = () => {
      if (wheelNavigationResetTimerRef.current) {
        clearTimeout(wheelNavigationResetTimerRef.current);
      }

      wheelNavigationResetTimerRef.current = setTimeout(() => {
        wheelNavigationCycleLockedRef.current = false;
        wheelNavigationResetTimerRef.current = null;
      }, WHEEL_PAGE_TURN_IDLE_MS);
    };

    const handleWheelNavigation = (event: WheelEvent | React.WheelEvent) => {
      if (event.ctrlKey) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (effectiveNavMode === 'scroll') {
        if (hasSelectionRef.current) clearTextSelection();
        markUserProgressChange();
        return;
      }

      if (isEditableKeyboardTarget(event.target)) return;

      const isReaderPanelOpen = chrome.showControls
        || chrome.showSettings
        || chrome.showThemeModal
        || chrome.showBookmarks
        || chrome.showToc
        || chrome.showSearchModal
        || chrome.showJumpInput;
      if (isReaderPanelOpen) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const absDeltaX = Math.abs(event.deltaX);
      const absDeltaY = Math.abs(event.deltaY);
      if (absDeltaX < WHEEL_PAGE_TURN_MIN_DELTA && absDeltaY < WHEEL_PAGE_TURN_MIN_DELTA) return;

      event.preventDefault();
      event.stopPropagation();
      unlockWheelNavigationAfterIdle();

      if (wheelNavigationCycleLockedRef.current) return;
      wheelNavigationCycleLockedRef.current = true;

      const dominantDelta = absDeltaX > absDeltaY ? event.deltaX : event.deltaY;
      if (hasSelectionRef.current) clearTextSelection();
      markUserProgressChange();
      if (dominantDelta < 0) prev();
      else next();
    };

    wheelNavigationRef.current = handleWheelNavigation;
    return () => {
      if (wheelNavigationRef.current === handleWheelNavigation) {
        wheelNavigationRef.current = () => undefined;
      }
    };
  }, [
    chrome.showBookmarks,
    chrome.showControls,
    chrome.showJumpInput,
    chrome.showSearchModal,
    chrome.showSettings,
    chrome.showThemeModal,
    chrome.showToc,
    markUserProgressChange,
    next,
    prev,
    effectiveNavMode,
    clearTextSelection,
    hasSelectionRef,
  ]);

  useEffect(() => {
    if (!isLoaded) return;

    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target)) return;

      if (isReaderPanelOpenRef.current) return;

      if (
        isFixedLayout
        && event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.shiftKey
        && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        event.stopPropagation();
        adjustFixedLayoutZoom(
          event.key === 'ArrowUp' ? FIXED_LAYOUT_ZOOM_STEP : 1 / FIXED_LAYOUT_ZOOM_STEP,
          { x: window.innerWidth / 2, y: window.innerHeight / 2 },
        );
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

      const keyboardAction = getReaderKeyboardAction(effectiveNavMode, event.key);
      if (!keyboardAction) return;

      if (hasSelectionRef.current) clearTextSelection();

      if (effectiveNavMode === 'scroll') {
        event.preventDefault();
        const viewportSize = viewRef.current?.renderer?.size ?? window.innerHeight;
        const scrollDistance = Math.min(
          MAX_KEYBOARD_SCROLL_DISTANCE,
          Math.max(MIN_KEYBOARD_SCROLL_DISTANCE, Math.round(viewportSize * KEYBOARD_SCROLL_RATIO))
        );

        markUserProgressChange();
        if (keyboardAction === 'prev') prev(scrollDistance);
        else next(scrollDistance);
        return;
      }

      event.preventDefault();
      if (event.repeat) return;

      markUserProgressChange();
      if (keyboardAction === 'prev') prev();
      else next();
    };

    keyboardNavigationRef.current = handleKeyboardNavigation;
    window.addEventListener('keydown', handleKeyboardNavigation);
    return () => {
      window.removeEventListener('keydown', handleKeyboardNavigation);
      if (keyboardNavigationRef.current === handleKeyboardNavigation) {
        keyboardNavigationRef.current = () => undefined;
      }
    };
  }, [
    chrome.showBookmarks,
    chrome.showJumpInput,
    chrome.showSearchModal,
    chrome.showSettings,
    chrome.showThemeModal,
    chrome.showToc,
    adjustFixedLayoutZoom,
    isFixedLayout,
    isLoaded,
    markUserProgressChange,
    next,
    prev,
    effectiveNavMode,
    clearTextSelection,
    hasSelectionRef,
    viewRef,
  ]);

  const performJump = useCallback(async (targetCfi: string) => {
    const currentLocationCfi = currentAnchorCfi || currentCfi;
    if (!currentCfi || targetCfi === currentCfi || targetCfi === currentLocationCfi) return;

    const updatedBookmarks = createAutoBookmark(currentLocationCfi, totalProgress);
    markUserProgressChange({
      forceNextRelocateSave: true,
      bookmarks: updatedBookmarks,
    });
    await goTo(targetCfi);
  }, [createAutoBookmark, currentAnchorCfi, currentCfi, goTo, markUserProgressChange, totalProgress]);

  const performJumpToProgress = useCallback(async (targetCfi: string, expectedPercent?: number) => {
    const currentLocationCfi = currentAnchorCfi || currentCfi;
    if (!currentCfi || targetCfi === currentCfi || targetCfi === currentLocationCfi) return;

    const updatedBookmarks = createAutoBookmark(currentLocationCfi, totalProgress);
    markUserProgressChange({
      forceNextRelocateSave: true,
      expectedPercent,
      bookmarks: updatedBookmarks,
    });
    await goTo(targetCfi);
  }, [createAutoBookmark, currentAnchorCfi, currentCfi, goTo, markUserProgressChange, totalProgress]);

  const performJumpFraction = useCallback(async (fraction: number) => {
    const targetPct = fraction * 100;
    const updatedBookmarks = Math.abs(targetPct - totalProgress) > 5
      ? createAutoBookmark(currentAnchorCfi || currentCfi, totalProgress)
      : undefined;

    markUserProgressChange({
      forceNextRelocateSave: true,
      expectedPercent: targetPct,
      bookmarks: updatedBookmarks,
    });
    await goToFraction(fraction);
  }, [createAutoBookmark, currentAnchorCfi, currentCfi, goToFraction, markUserProgressChange, totalProgress]);

  const handleJump = useCallback(() => {
    const trimmed = chrome.jumpInput.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('epubcfi(')) {
      void performJump(trimmed);
    } else {
      const pct = parseFloat(trimmed.replace('%', ''));
      if (!Number.isNaN(pct)) {
        void performJumpFraction(Math.min(100, Math.max(0, pct)) / 100);
      }
    }

    chrome.closeJumpInput();
  }, [chrome, performJump, performJumpFraction]);

  return (
    <div
      className={`h-screen w-screen ${theme.bg} ${theme.text} transition-colors duration-300 select-none overflow-hidden`}
      style={readerShellStyle}
    >
      {!isLoaded && (
        <div className={`absolute inset-0 z-[100] flex flex-col items-center justify-center gap-5 ${theme.bg} text-xs font-black uppercase tracking-widest`}>
          <p className="opacity-50" role="status" aria-live="polite">
            {book.readerFormat === 'pdf'
              ? 'PDF 준비 중...'
              : isFixedLayout ? '압축 파일 확인 중...' : 'Loading...'}
          </p>
          <button
            type="button"
            onClick={handleReaderBack}
            className={`rounded-xl border ${theme.border} px-4 py-3 text-xs font-bold normal-case tracking-normal opacity-100`}
          >
            서재로 돌아가기
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          boxSizing: 'border-box',
          paddingBlock: `${readerEdgePadding}px`,
          position: 'relative',
        }}
      />

      {isLoaded && isFixedLayout && effectiveNavMode !== 'scroll' && (
        <div
          data-reader-interaction-overlay="true"
          className="fixed inset-0 z-10"
          style={{
            background: 'transparent',
            touchAction: isFixedLayout ? 'none' : 'auto',
          }}
          onClick={handleInteraction}
          onTouchStart={handleFixedLayoutTouchStart}
          onTouchMove={handleFixedLayoutTouchMove}
          onTouchEnd={handleFixedLayoutTouchEnd}
          onTouchCancel={handleFixedLayoutTouchEnd}
          onPointerDown={handleFixedLayoutPointerDown}
          onPointerMove={handleFixedLayoutPointerMove}
          onPointerUp={handleFixedLayoutPointerEnd}
          onPointerCancel={handleFixedLayoutPointerEnd}
          onLostPointerCapture={handleFixedLayoutLostPointerCapture}
          onWheel={(event) => wheelNavigationRef.current(event)}
        />
      )}

      {chrome.showControls && isFixedLayout && (
        <div
          ref={controlsOverlayRef}
          data-reader-controls-overlay="true"
          className="fixed inset-0 z-40 touch-none"
          style={{ background: 'transparent' }}
          onClick={handleControlsOverlayClick}
          onTouchStart={handleFixedLayoutTouchStart}
          onTouchMove={handleFixedLayoutTouchMove}
          onTouchEnd={handleFixedLayoutTouchEnd}
          onTouchCancel={handleFixedLayoutTouchEnd}
          onPointerDown={handleFixedLayoutPointerDown}
          onPointerMove={handleFixedLayoutPointerMove}
          onPointerUp={handleFixedLayoutPointerEnd}
          onPointerCancel={handleFixedLayoutPointerEnd}
          onLostPointerCapture={handleFixedLayoutLostPointerCapture}
        />
      )}

      {isLoaded && selectedText && !isReaderPanelOpen && !isFixedLayout && (
        <TextSelectionMenu
          selection={selectedText}
          feedback={selectionFeedback}
          canShare={canShareSelection}
          theme={theme}
          onCopy={() => void copySelection()}
          onShare={() => void shareSelection()}
          onHighlight={(colorId) => void createHighlight(selectedText, colorId)}
          onClose={clearTextSelection}
        />
      )}

      {isLoaded && activeHighlight && !isReaderPanelOpen && !isFixedLayout && (
        <HighlightActionMenu
          annotation={activeHighlight.annotation}
          theme={theme}
          x={activeHighlight.x}
          top={activeHighlight.top}
          bottom={activeHighlight.bottom}
          onChangeColor={(colorId) => void changeActiveColor(colorId)}
          onDelete={() => void deleteActiveHighlight()}
          onClose={closeActiveHighlight}
        />
      )}

      {annotationFeedback && (
        <div
          data-reader-annotation-feedback="true"
          role="status"
          aria-live="polite"
          className={`fixed bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] left-1/2 z-[82] flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-2 rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} px-4 py-2 text-center text-xs font-bold shadow-2xl`}
        >
          <span>{annotationFeedback}</span>
          {canUndoAnnotation && (
            <button
              type="button"
              onClick={() => void undoLastMutation()}
              className="min-h-11 shrink-0 rounded-full px-3 text-accent-500 hover:bg-black/5 active:scale-95 dark:hover:bg-white/10"
            >
              실행 취소
            </button>
          )}
        </div>
      )}

      {isLoaded && (
        <ReaderStatusBar
          theme={theme}
          currentChapter={currentChapter}
          totalProgress={totalProgress}
          onOpenJump={chrome.openJumpInput}
        />
      )}

      <ReaderToolbar
        theme={theme}
        bookName={book.name}
        showControls={chrome.showControls}
        sliderProgress={sliderProgress}
        isSliderPreviewing={isSliderPreviewing}
        sliderPreviewChapter={sliderTargetChapter}
        bookmarkCount={bookmarks.length}
        isFixedLayout={isFixedLayout}
        onBack={chrome.handleUIBack}
        onOpenSearch={() => chrome.setShowSearchModal(true)}
        onOpenSettings={() => chrome.setShowSettings(true)}
        onOpenTheme={() => chrome.setShowThemeModal(true)}
        onOpenBookmarks={() => chrome.setShowBookmarks(true)}
        onOpenToc={() => chrome.setShowToc(true)}
        onProgressSliderStart={beginSliderMove}
        onProgressSliderPreview={previewSliderMove}
        onProgressSliderCommit={commitSliderMove}
      />

      {chrome.showSettings && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => chrome.setShowSettings(false)}
          theme={theme}
          isFixedLayout={isFixedLayout}
        />
      )}

      {chrome.showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => chrome.setShowThemeModal(false)}
          theme={theme}
        />
      )}

      {chrome.showBookmarks && (
        <BookmarkModal
          bookmarks={bookmarks}
          theme={theme}
          onClose={() => chrome.setShowBookmarks(false)}
          onAdd={addBookmark}
          onDelete={deleteBookmark}
          onJump={(cfi, progressPercent) => { void performJumpToProgress(cfi, progressPercent); chrome.setShowBookmarks(false); }}
        />
      )}

      {chrome.showToc && (
        <TocModal
          toc={toc}
          theme={theme}
          onClose={() => chrome.setShowToc(false)}
          onJump={(href, progressPercent) => { void performJumpToProgress(href, progressPercent); chrome.setShowToc(false); }}
          currentChapter={currentChapter}
        />
      )}

      {!isFixedLayout && chrome.showSearchModal && (
        <EpubSearchModal
          theme={theme}
          onClose={() => chrome.setShowSearchModal(false)}
          onSelect={(cfi, progressPercent) => { void performJumpToProgress(cfi, progressPercent); chrome.setShowSearchModal(false); }}
          onSearch={searchBook}
          onClear={clearSearch}
        />
      )}

      {chrome.showJumpInput && (
        <JumpDialog
          theme={theme}
          value={chrome.jumpInput}
          onChange={chrome.setJumpInput}
          onSubmit={handleJump}
          onClose={chrome.closeJumpInput}
        />
      )}

      {pendingSliderMove && (
        <ProgressJumpConfirmDialog
          theme={theme}
          targetPercent={pendingSliderMove.targetPercent}
          targetChapter={pendingSliderTargetChapter}
          onCancel={cancelSliderMove}
          onConfirm={() => { void confirmSliderMove(); }}
        />
      )}

      {syncConflict && (
        <SyncConflictDialog
          theme={theme}
          syncConflict={syncConflict}
          onDismiss={dismissSyncConflict}
          onAccept={acceptSyncConflict}
        />
      )}
    </div>
  );
};

export default EpubReaderInner;
