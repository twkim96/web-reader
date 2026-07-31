'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type {
  Annotation,
  AnnotationAnchorState,
  HighlightColorId,
} from '../../types';
import type {
  FoliateCreateOverlayDetail,
  FoliateDrawAnnotationDetail,
  FoliateShowAnnotationDetail,
  FoliateViewElement,
} from '../foliate/types';
import type { OwnerKey } from '../../lib/ownerIdentity';
import type { ReaderTextSelection } from './useReaderTextSelection';
import {
  ANNOTATION_QUOTE_MAX_LENGTH,
  getHighlightColor,
  verifyAnnotationAnchor,
} from '../../lib/annotationPolicy';
import {
  deleteLocalAnnotationV8,
  getLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationAnchorStateV8,
  updateLocalAnnotationResolutionV8,
} from '../../lib/localAnnotations';
import { drawHighlightRects, toFoliateAnnotation } from '../../lib/annotationOverlay';
import {
  getDocumentFrameMetrics,
  getRangeTextContext,
  getRangeViewportAnchor,
  type SelectionViewportAnchor,
} from '../../lib/readerTextSelection';
import { toClampedPercent } from '../foliate/progress';

type ActiveHighlight = SelectionViewportAnchor & { annotation: Annotation };

type AnnotationMutation = {
  before: Annotation | null;
  after: Annotation | null;
};

interface UseReaderAnnotationsOptions {
  enabled: boolean;
  ownerKey: OwnerKey;
  bookId: string;
  viewRef: MutableRefObject<FoliateViewElement | null>;
  isLoaded: boolean;
  currentProgress: number;
  currentChapter: string;
  clearTextSelection: () => void;
}

const mutationMessage = (before: Annotation | null, after: Annotation | null) => {
  if (!before) return `${after ? getHighlightColor(after.colorId).label : ''} 하이라이트 추가됨`;
  if (!after) return '하이라이트 삭제됨';
  if (before.colorId === after.colorId) return '하이라이트 위치 정보 갱신됨';
  return `${getHighlightColor(after.colorId).label}으로 변경됨`;
};

export const useReaderAnnotations = ({
  enabled,
  ownerKey,
  bookId,
  viewRef,
  isLoaded,
  currentProgress,
  currentChapter,
  clearTextSelection,
}: UseReaderAnnotationsOptions) => {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeHighlight, setActiveHighlight] = useState<ActiveHighlight | null>(null);
  const [feedback, setFeedback] = useState('');
  const [undoMutation, setUndoMutation] = useState<AnnotationMutation | null>(null);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const annotationsRef = useRef<Annotation[]>([]);
  const feedbackTimerRef = useRef<number | null>(null);
  const loadGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);

  const replaceAnnotations = useCallback((next: Annotation[]) => {
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const showFeedback = useCallback((message: string, keepUndo = false) => {
    setFeedback(message);
    if (!keepUndo) setUndoMutation(null);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setFeedback('');
      setUndoMutation(null);
    }, keepUndo ? 6000 : 2400);
  }, []);

  const closeActiveHighlight = useCallback(() => {
    setActiveHighlight(null);
  }, []);

  const removeAnnotationOverlay = useCallback(async (annotation: Annotation) => {
    const view = viewRef.current;
    if (!view) return;
    await view.deleteAnnotation(toFoliateAnnotation(annotation));
  }, [viewRef]);

  const markAnchorState = useCallback(async (
    annotationId: string,
    anchorState: AnnotationAnchorState,
  ) => {
    const current = annotationsRef.current.find(({ id }) => id === annotationId);
    if (!current || current.anchorState === anchorState) return;
    const result = await updateLocalAnnotationAnchorStateV8(
      ownerKey,
      bookId,
      annotationId,
      anchorState,
    );
    if (!result) return;
    replaceAnnotations(annotationsRef.current.map((annotation) => (
      annotation.id === annotationId ? { ...annotation, anchorState } : annotation
    )));
  }, [bookId, ownerKey, replaceAnnotations]);

  const reconcileSectionIndex = useCallback(async (
    annotationId: string,
    sectionIndex: number,
  ) => {
    const current = annotationsRef.current.find(({ id }) => id === annotationId);
    if (!current || current.sectionIndex === sectionIndex) return;
    replaceAnnotations(annotationsRef.current.map((annotation) => (
      annotation.id === annotationId ? { ...annotation, sectionIndex } : annotation
    )));
    setActiveHighlight((active) => active?.annotation.id === annotationId
      ? { ...active, annotation: { ...active.annotation, sectionIndex } }
      : active);
    await updateLocalAnnotationResolutionV8(
      ownerKey,
      bookId,
      annotationId,
      sectionIndex,
    );
  }, [bookId, ownerKey, replaceAnnotations]);

  const renderAnnotation = useCallback(async (annotation: Annotation) => {
    const view = viewRef.current;
    if (!view) return;
    let resolved;
    try {
      resolved = await view.addAnnotation(toFoliateAnnotation(annotation));
    } catch (error) {
      await markAnchorState(annotation.id, 'unresolved');
      throw error;
    }
    if (!resolved) {
      await markAnchorState(annotation.id, 'unresolved');
      return;
    }
    const sectionCount = view.book?.sections?.length;
    if (
      !Number.isSafeInteger(resolved.index)
      || resolved.index < 0
      || typeof sectionCount === 'number' && resolved.index >= sectionCount
    ) {
      await markAnchorState(annotation.id, 'unresolved');
      return;
    }
    await reconcileSectionIndex(annotation.id, resolved.index);
  }, [markAnchorState, reconcileSectionIndex, viewRef]);

  const renderAnnotations = useCallback((items: Annotation[]) => {
    for (const annotation of items) {
      void renderAnnotation(annotation).catch((error) => {
        console.warn('[EpubReader] Failed to restore annotation:', error);
      });
    }
  }, [renderAnnotation]);

  const renderAllAnnotations = useCallback(() => {
    renderAnnotations(annotationsRef.current);
  }, [renderAnnotations]);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    setActiveHighlight(null);
    setUndoMutation(null);
    setFeedback('');
    setAnnotationsLoaded(false);
    if (!enabled) {
      replaceAnnotations([]);
      return () => {
        loadGenerationRef.current += 1;
      };
    }
    void getLocalAnnotationsV8(ownerKey, bookId)
      .then((items) => {
        if (generation === loadGenerationRef.current) {
          replaceAnnotations(items);
          setAnnotationsLoaded(true);
        }
      })
      .catch((error) => {
        console.warn('[EpubReader] Failed to load local annotations:', error);
        if (generation === loadGenerationRef.current) showFeedback('하이라이트 불러오기 실패');
      });
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [bookId, enabled, ownerKey, replaceAnnotations, showFeedback]);

  useEffect(() => {
    if (!enabled || !isLoaded) return;
    const view = viewRef.current;
    if (!view) return;

    const handleDraw = (event: Event) => {
      const detail = (event as CustomEvent<FoliateDrawAnnotationDetail>).detail;
      const annotation = annotationsRef.current.find(({ id }) => (
        id === detail?.annotation?.annotationId
      ));
      if (!annotation || !detail?.range || !detail.doc) return;
      const context = getRangeTextContext(detail.range, detail.doc.body || detail.doc.documentElement);
      const valid = verifyAnnotationAnchor(annotation, {
        quote: detail.range.toString(),
        ...context,
      });
      if (!valid) {
        void markAnchorState(annotation.id, 'unresolved');
        return;
      }
      detail.draw(drawHighlightRects, { color: getHighlightColor(annotation.colorId).color });
      void markAnchorState(annotation.id, 'active');
    };

    const handleShow = (event: Event) => {
      const detail = (event as CustomEvent<FoliateShowAnnotationDetail>).detail;
      const annotation = annotationsRef.current.find(({ rangeCfi }) => rangeCfi === detail?.value);
      if (!annotation || !detail?.range) return;
      const doc = detail.range.startContainer.ownerDocument;
      if (!doc) return;
      const anchor = getRangeViewportAnchor(
        detail.range,
        getDocumentFrameMetrics(doc),
        window.innerWidth,
        window.innerHeight,
      );
      if (!anchor) return;
      clearTextSelection();
      setActiveHighlight({ annotation, ...anchor });
    };

    const handleCreateOverlay = (event: Event) => {
      const { index } = (event as CustomEvent<FoliateCreateOverlayDetail>).detail || {};
      setActiveHighlight(null);
      queueMicrotask(() => {
        if (!Number.isSafeInteger(index) || index < 0) {
          renderAllAnnotations();
          return;
        }
        renderAnnotations(annotationsRef.current.filter((annotation) => (
          annotation.sectionIndex === index
        )));
      });
    };

    view.addEventListener('draw-annotation', handleDraw);
    view.addEventListener('show-annotation', handleShow);
    view.addEventListener('create-overlay', handleCreateOverlay);
    return () => {
      view.removeEventListener('draw-annotation', handleDraw);
      view.removeEventListener('show-annotation', handleShow);
      view.removeEventListener('create-overlay', handleCreateOverlay);
    };
  }, [clearTextSelection, enabled, isLoaded, markAnchorState, renderAllAnnotations, renderAnnotations, viewRef]);

  useEffect(() => {
    if (!enabled || !isLoaded || !annotationsLoaded) return;
    renderAllAnnotations();
  }, [annotationsLoaded, enabled, isLoaded, renderAllAnnotations]);

  const saveMutation = useCallback(async (
    before: Annotation | null,
    after: Annotation,
  ) => {
    const result = await saveLocalAnnotationV8(ownerKey, after);
    if (result.status === 'book-limit') {
      showFeedback('이 책은 하이라이트 100개까지 저장할 수 있어요');
      return false;
    }
    if (result.status === 'color-limit') {
      showFeedback(`${getHighlightColor(after.colorId).label} 하이라이트는 20개까지 저장할 수 있어요`);
      return false;
    }
    if (result.status === 'duplicate-range') {
      showFeedback('같은 범위의 하이라이트가 이미 있어요');
      return false;
    }
    const next = before
      ? annotationsRef.current.map((annotation) => annotation.id === after.id ? after : annotation)
      : [...annotationsRef.current, after];
    replaceAnnotations(next);
    setActiveHighlight((current) => current?.annotation.id === after.id
      ? { ...current, annotation: after }
      : current);
    setUndoMutation({ before, after });
    showFeedback(mutationMessage(before, after), true);
    void renderAnnotation(after).catch((error) => {
      console.warn('[EpubReader] Failed to draw saved annotation:', error);
    });
    return true;
  }, [ownerKey, renderAnnotation, replaceAnnotations, showFeedback]);

  const createHighlight = useCallback(async (
    selection: ReaderTextSelection,
    colorId: HighlightColorId,
  ) => {
    if (!enabled || mutationInFlightRef.current) return;
    if (selection.text.length > ANNOTATION_QUOTE_MAX_LENGTH) {
      showFeedback('선택 범위가 너무 길어요');
      return;
    }
    const view = viewRef.current;
    if (!view || selection.index < 0) {
      showFeedback('이 범위는 하이라이트할 수 없어요');
      return;
    }
    mutationInFlightRef.current = true;
    try {
      const rangeCfi = view.getCFI(selection.index, selection.range);
      const existing = annotationsRef.current.find((annotation) => annotation.rangeCfi === rangeCfi) ?? null;
      const now = Date.now();
      const next: Annotation = existing ? {
        ...existing,
        sectionIndex: selection.index,
        quote: selection.text,
        prefix: selection.prefix,
        suffix: selection.suffix,
        colorId,
        updatedAtClient: Math.max(now, existing.updatedAtClient + 1),
        anchorState: 'active',
      } : {
        id: crypto.randomUUID(),
        bookId,
        type: 'highlight',
        sectionIndex: selection.index,
        rangeCfi,
        quote: selection.text,
        prefix: selection.prefix,
        suffix: selection.suffix,
        colorId,
        note: '',
        progressPercent: toClampedPercent(currentProgress),
        chapter: currentChapter.slice(0, 500),
        createdAtClient: now,
        updatedAtClient: now,
        anchorState: 'active',
      };
      if (
        existing?.colorId === colorId
        && existing.sectionIndex === selection.index
        && existing.quote === selection.text
        && existing.prefix === selection.prefix
        && existing.suffix === selection.suffix
        && existing.anchorState === 'active'
      ) {
        clearTextSelection();
        showFeedback('이미 같은 색으로 표시되어 있어요');
        return;
      }
      if (await saveMutation(existing, next)) clearTextSelection();
    } catch (error) {
      console.warn('[EpubReader] Failed to create annotation:', error);
      showFeedback('하이라이트 저장 실패');
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [bookId, clearTextSelection, currentChapter, currentProgress, enabled, saveMutation, showFeedback, viewRef]);

  const changeActiveColor = useCallback(async (colorId: HighlightColorId) => {
    const before = activeHighlight?.annotation;
    if (!before || before.colorId === colorId || mutationInFlightRef.current) return;
    const next = {
      ...before,
      colorId,
      updatedAtClient: Math.max(Date.now(), before.updatedAtClient + 1),
    };
    mutationInFlightRef.current = true;
    try {
      await saveMutation(before, next);
    } catch (error) {
      console.warn('[EpubReader] Failed to update annotation:', error);
      showFeedback('색상 변경 실패');
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [activeHighlight?.annotation, saveMutation, showFeedback]);

  const deleteActiveHighlight = useCallback(async () => {
    const before = activeHighlight?.annotation;
    if (!before || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    try {
      const deleted = await deleteLocalAnnotationV8(ownerKey, bookId, before.id);
      if (!deleted) return;
      replaceAnnotations(annotationsRef.current.filter(({ id }) => id !== before.id));
      setActiveHighlight(null);
      setUndoMutation({ before, after: null });
      showFeedback(mutationMessage(before, null), true);
      void removeAnnotationOverlay(deleted).catch((error) => {
        console.warn('[EpubReader] Failed to remove deleted annotation overlay:', error);
      });
    } catch (error) {
      console.warn('[EpubReader] Failed to delete annotation:', error);
      showFeedback('하이라이트 삭제 실패');
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [activeHighlight?.annotation, bookId, ownerKey, removeAnnotationOverlay, replaceAnnotations, showFeedback]);

  const undoLastMutation = useCallback(async () => {
    const mutation = undoMutation;
    if (!mutation || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    try {
      if (!mutation.before && mutation.after) {
        await deleteLocalAnnotationV8(ownerKey, bookId, mutation.after.id);
        replaceAnnotations(annotationsRef.current.filter(({ id }) => id !== mutation.after?.id));
        setActiveHighlight(null);
        setUndoMutation(null);
        showFeedback('실행 취소됨');
        void removeAnnotationOverlay(mutation.after).catch((error) => {
          console.warn('[EpubReader] Failed to remove undone annotation overlay:', error);
        });
      } else if (mutation.before) {
        const restored = {
          ...mutation.before,
          updatedAtClient: Math.max(
            Date.now(),
            (mutation.after?.updatedAtClient ?? mutation.before.updatedAtClient) + 1,
          ),
        };
        const result = await saveLocalAnnotationV8(ownerKey, restored);
        if (result.status !== 'saved') throw new Error(`undo failed: ${result.status}`);
        const exists = annotationsRef.current.some(({ id }) => id === restored.id);
        replaceAnnotations(exists
          ? annotationsRef.current.map((annotation) => annotation.id === restored.id
            ? restored
            : annotation)
          : [...annotationsRef.current, restored]);
        setActiveHighlight(null);
        setUndoMutation(null);
        showFeedback('실행 취소됨');
        void renderAnnotation(restored).catch((error) => {
          console.warn('[EpubReader] Failed to restore undone annotation overlay:', error);
        });
      }
    } catch (error) {
      console.warn('[EpubReader] Failed to undo annotation mutation:', error);
      setUndoMutation(mutation);
      showFeedback('실행 취소 실패', true);
    } finally {
      mutationInFlightRef.current = false;
    }
  }, [bookId, ownerKey, removeAnnotationOverlay, renderAnnotation, replaceAnnotations, showFeedback, undoMutation]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  return {
    annotations,
    activeHighlight,
    feedback,
    canUndo: Boolean(undoMutation),
    createHighlight,
    changeActiveColor,
    deleteActiveHighlight,
    closeActiveHighlight,
    undoLastMutation,
  };
};
