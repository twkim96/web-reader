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
  deleteLocalAnnotationsV8,
  deleteLocalAnnotationsIfUnchangedV8,
  getLocalAnnotationsV8,
  restoreLocalAnnotationFieldsV8,
  restoreLocalAnnotationsV8,
  saveLocalAnnotationV8,
  updateLocalAnnotationFieldsV8,
  updateLocalAnnotationColorsV8,
  updateLocalAnnotationAnchorStateV8,
  updateLocalAnnotationResolutionV8,
  type AnnotationFieldPatchV8,
  type LocalAnnotationSyncContext,
  type AnnotationMutableFields,
} from '../../lib/localAnnotations';
import { drawHighlightRects, toFoliateAnnotation } from '../../lib/annotationOverlay';
import {
  getDocumentFrameMetrics,
  getRangeTextContext,
  getRangeViewportAnchor,
  isPointInsideRects,
  type SelectionViewportAnchor,
} from '../../lib/readerTextSelection';
import { toClampedPercent } from '../foliate/progress';

type ActiveHighlight = SelectionViewportAnchor & { annotation: Annotation };

const HIGHLIGHT_TAP_SLOP_PX = 6;

type AnnotationUndo =
  | { type: 'create'; annotations: Annotation[] }
  | { type: 'delete'; annotations: Annotation[] }
  | { type: 'fields'; patches: AnnotationFieldPatchV8[] };

interface UseReaderAnnotationsOptions {
  enabled: boolean;
  ownerKey: OwnerKey;
  bookId: string;
  viewRef: MutableRefObject<FoliateViewElement | null>;
  isLoaded: boolean;
  currentProgress: number;
  currentChapter: string;
  clearTextSelection: () => void;
  syncContext?: LocalAnnotationSyncContext;
  externalRevision?: number;
}

const mutationMessage = (before: Annotation | null, after: Annotation | null) => {
  if (!before) return `${after ? getHighlightColor(after.colorId).label : ''} 하이라이트 추가됨`;
  if (!after) return '하이라이트 삭제됨';
  if (before.colorId === after.colorId) return '하이라이트 위치 정보 갱신됨';
  return `${getHighlightColor(after.colorId).label}으로 변경됨`;
};

const ANNOTATION_UNDO_DURATION_MS = 1000;

export const useReaderAnnotations = ({
  enabled,
  ownerKey,
  bookId,
  viewRef,
  isLoaded,
  currentProgress,
  currentChapter,
  clearTextSelection,
  syncContext,
  externalRevision = 0,
}: UseReaderAnnotationsOptions) => {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [activeHighlight, setActiveHighlight] = useState<ActiveHighlight | null>(null);
  const [feedback, setFeedback] = useState('');
  const [undoMutation, setUndoMutation] = useState<AnnotationUndo | null>(null);
  const [isMutating, setIsMutating] = useState(false);
  const [annotationsLoaded, setAnnotationsLoaded] = useState(false);
  const annotationsRef = useRef<Annotation[]>([]);
  const feedbackTimerRef = useRef<number | null>(null);
  const loadGenerationRef = useRef(0);
  const mutationInFlightRef = useRef(false);
  const flashTimerRef = useRef<number | null>(null);
  const flashCleanupRef = useRef<(() => void) | null>(null);
  const renderedRangesRef = useRef<WeakMap<Document, Map<string, Range>>>(new WeakMap());

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
    }, keepUndo ? ANNOTATION_UNDO_DURATION_MS : 2400);
  }, []);

  const closeActiveHighlight = useCallback(() => {
    setActiveHighlight(null);
  }, []);

  const openHighlightAtPoint = useCallback((
    doc: Document,
    point: { x: number; y: number },
  ) => {
    const ranges = renderedRangesRef.current.get(doc);
    if (!ranges) return false;
    for (let index = annotationsRef.current.length - 1; index >= 0; index -= 1) {
      const annotation = annotationsRef.current[index];
      if (annotation.anchorState === 'unresolved') continue;
      const range = ranges.get(annotation.id);
      if (!range) continue;
      let hit = false;
      try {
        hit = isPointInsideRects(
          Array.from(range.getClientRects()),
          point,
          HIGHLIGHT_TAP_SLOP_PX,
        );
      } catch {
        continue;
      }
      if (!hit) continue;
      const anchor = getRangeViewportAnchor(
        range,
        getDocumentFrameMetrics(doc),
        window.innerWidth,
        window.innerHeight,
      );
      if (!anchor) continue;
      clearTextSelection();
      setActiveHighlight({ annotation, ...anchor });
      return true;
    }
    return false;
  }, [clearTextSelection]);

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
      annotation.id === annotationId ? result : annotation
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
    const result = await updateLocalAnnotationResolutionV8(
      ownerKey,
      bookId,
      annotationId,
      sectionIndex,
    );
    if (!result) return;
    replaceAnnotations(annotationsRef.current.map((annotation) => (
      annotation.id === annotationId ? result : annotation
    )));
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
    renderedRangesRef.current = new WeakMap();
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
      .then(async (items) => {
        if (generation !== loadGenerationRef.current) return;
        if (externalRevision > 0) {
          await Promise.allSettled(
            annotationsRef.current.map(removeAnnotationOverlay),
          );
        }
        if (generation !== loadGenerationRef.current) return;
        replaceAnnotations(items);
        setAnnotationsLoaded(true);
      })
      .catch((error) => {
        console.warn('[EpubReader] Failed to load local annotations:', error);
        if (generation === loadGenerationRef.current) showFeedback('하이라이트 불러오기 실패');
      });
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [bookId, enabled, externalRevision, ownerKey, removeAnnotationOverlay, replaceAnnotations, showFeedback]);

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
      const renderedRanges = renderedRangesRef.current.get(detail.doc) ?? new Map<string, Range>();
      renderedRanges.set(annotation.id, detail.range.cloneRange());
      renderedRangesRef.current.set(detail.doc, renderedRanges);
      detail.draw((rects, options) => {
        const group = drawHighlightRects(rects, options);
        group.setAttribute('data-reader-annotation-id', annotation.id);
        return group;
      }, { color: getHighlightColor(annotation.colorId).color });
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

  const applySavedAnnotation = useCallback((
    before: Annotation | null,
    after: Annotation,
    undo: AnnotationUndo,
    message = mutationMessage(before, after),
  ) => {
    replaceAnnotations(before
      ? annotationsRef.current.map((annotation) => annotation.id === after.id ? after : annotation)
      : [...annotationsRef.current, after]);
    setActiveHighlight((current) => current?.annotation.id === after.id
      ? { ...current, annotation: after }
      : current);
    setUndoMutation(undo);
    showFeedback(message, true);
    void renderAnnotation(after).catch((error) => {
      console.warn('[EpubReader] Failed to draw saved annotation:', error);
    });
  }, [renderAnnotation, replaceAnnotations, showFeedback]);

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
    setIsMutating(true);
    try {
      const rangeCfi = view.getCFI(selection.index, selection.range);
      const existing = annotationsRef.current.find((annotation) => annotation.rangeCfi === rangeCfi) ?? null;
      const now = Date.now();
      if (existing) {
        const fields: Partial<AnnotationMutableFields> = {
          sectionIndex: selection.index,
          quote: selection.text,
          prefix: selection.prefix,
          suffix: selection.suffix,
          colorId,
          anchorState: 'active',
        };
        const result = await updateLocalAnnotationFieldsV8(
          ownerKey,
          bookId,
          existing.id,
          fields,
          syncContext,
        );
        if (result.status === 'unchanged') {
          clearTextSelection();
          showFeedback('이미 같은 색으로 표시되어 있어요');
          return;
        }
        if (result.status === 'missing') {
          replaceAnnotations(annotationsRef.current.filter(({ id }) => id !== existing.id));
          showFeedback('다른 탭에서 삭제된 하이라이트예요. 다시 선택해 주세요');
          return;
        }
        if (result.status === 'color-limit') {
          showFeedback(`${getHighlightColor(colorId).label} 하이라이트는 20개까지 저장할 수 있어요`);
          return;
        }
        if (result.status === 'duplicate-range') {
          showFeedback('같은 범위의 하이라이트가 이미 있어요');
          return;
        }
        const beforeFields: Partial<AnnotationMutableFields> = {
          sectionIndex: result.before.sectionIndex,
          quote: result.before.quote,
          prefix: result.before.prefix,
          suffix: result.before.suffix,
          colorId: result.before.colorId,
          anchorState: result.before.anchorState,
        };
        applySavedAnnotation(result.before, result.annotation, {
          type: 'fields',
          patches: [{ id: result.annotation.id, fields: beforeFields, expected: fields }],
        });
        clearTextSelection();
        return;
      }
      const next: Annotation = {
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
      const result = await saveLocalAnnotationV8(ownerKey, next, syncContext);
      if (result.status === 'book-limit') {
        showFeedback('이 책은 하이라이트 100개까지 저장할 수 있어요');
        return;
      }
      if (result.status === 'color-limit') {
        showFeedback(`${getHighlightColor(next.colorId).label} 하이라이트는 20개까지 저장할 수 있어요`);
        return;
      }
      if (result.status === 'duplicate-range') {
        showFeedback('같은 범위의 하이라이트가 이미 있어요');
        return;
      }
      applySavedAnnotation(null, result.annotation, {
        type: 'create',
        annotations: [result.annotation],
      });
      clearTextSelection();
    } catch (error) {
      console.warn('[EpubReader] Failed to create annotation:', error);
      showFeedback('하이라이트 저장 실패');
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [applySavedAnnotation, bookId, clearTextSelection, currentChapter, currentProgress, enabled, ownerKey, replaceAnnotations, showFeedback, syncContext, viewRef]);

  const changeActiveColor = useCallback(async (colorId: HighlightColorId) => {
    const before = activeHighlight?.annotation;
    if (!before || before.colorId === colorId || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      const result = await updateLocalAnnotationFieldsV8(
        ownerKey,
        bookId,
        before.id,
        { colorId },
        syncContext,
      );
      if (result.status === 'color-limit') {
        showFeedback(`${getHighlightColor(colorId).label} 하이라이트는 20개까지 저장할 수 있어요`);
        return;
      }
      if (result.status === 'missing') {
        showFeedback('다른 탭에서 삭제된 하이라이트예요');
        return;
      }
      if (result.status === 'duplicate-range' || result.status === 'unchanged') return;
      applySavedAnnotation(result.before, result.annotation, {
        type: 'fields',
        patches: [{
          id: result.annotation.id,
          fields: { colorId: result.before.colorId },
          expected: { colorId: result.annotation.colorId },
        }],
      });
    } catch (error) {
      console.warn('[EpubReader] Failed to update annotation:', error);
      showFeedback('색상 변경 실패');
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [activeHighlight?.annotation, applySavedAnnotation, bookId, ownerKey, showFeedback, syncContext]);

  const deleteActiveHighlight = useCallback(async () => {
    const before = activeHighlight?.annotation;
    if (!before || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      const deleted = await deleteLocalAnnotationV8(
        ownerKey,
        bookId,
        before.id,
        syncContext,
      );
      if (!deleted) return;
      replaceAnnotations(annotationsRef.current.filter(({ id }) => id !== before.id));
      setActiveHighlight(null);
      setUndoMutation({ type: 'delete', annotations: [deleted] });
      showFeedback(mutationMessage(deleted, null), true);
      void removeAnnotationOverlay(deleted).catch((error) => {
        console.warn('[EpubReader] Failed to remove deleted annotation overlay:', error);
      });
    } catch (error) {
      console.warn('[EpubReader] Failed to delete annotation:', error);
      showFeedback('하이라이트 삭제 실패');
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [activeHighlight?.annotation, bookId, ownerKey, removeAnnotationOverlay, replaceAnnotations, showFeedback, syncContext]);

  const undoLastMutation = useCallback(async () => {
    const mutation = undoMutation;
    if (!mutation || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      if (mutation.type === 'create') {
        const result = await deleteLocalAnnotationsIfUnchangedV8(
          ownerKey,
          bookId,
          mutation.annotations,
          syncContext,
        );
        if (result.status !== 'deleted') throw new Error('undo failed: conflict');
        const creationIds = new Set(mutation.annotations.map(({ id }) => id));
        replaceAnnotations(annotationsRef.current.filter(({ id }) => !creationIds.has(id)));
        for (const annotation of mutation.annotations) {
          void removeAnnotationOverlay(annotation).catch((error) => {
            console.warn('[EpubReader] Failed to remove undone annotation overlay:', error);
          });
        }
      } else {
        const result = mutation.type === 'delete'
          ? await restoreLocalAnnotationsV8(ownerKey, bookId, mutation.annotations, syncContext)
          : await restoreLocalAnnotationFieldsV8(ownerKey, bookId, mutation.patches, syncContext);
        if (result.status !== 'saved') throw new Error(`undo failed: ${result.status}`);
        const restoredItems = result.annotations;
        const restoredById = new Map(restoredItems.map((annotation) => [annotation.id, annotation]));
        const retained = annotationsRef.current.filter(({ id }) => !restoredById.has(id));
        replaceAnnotations([...retained, ...restoredItems]);
        for (const restored of restoredItems) {
          void renderAnnotation(restored).catch((error) => {
            console.warn('[EpubReader] Failed to restore undone annotation overlay:', error);
          });
        }
      }
      setActiveHighlight(null);
      setUndoMutation(null);
      showFeedback('실행 취소됨');
    } catch (error) {
      console.warn('[EpubReader] Failed to undo annotation mutation:', error);
      setUndoMutation(mutation);
      showFeedback('다른 탭의 변경과 겹쳐 실행 취소할 수 없어요', true);
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [bookId, ownerKey, removeAnnotationOverlay, renderAnnotation, replaceAnnotations, showFeedback, syncContext, undoMutation]);

  const updateAnnotationNote = useCallback(async (annotationId: string, note: string) => {
    const before = annotationsRef.current.find(({ id }) => id === annotationId);
    if (!before) return false;
    if (before.note === note) return true;
    if (mutationInFlightRef.current) {
      showFeedback('진행 중인 하이라이트 작업이 끝난 뒤 다시 저장해 주세요');
      return false;
    }
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      const result = await updateLocalAnnotationFieldsV8(
        ownerKey,
        bookId,
        annotationId,
        { note },
        syncContext,
      );
      if (result.status === 'missing') {
        showFeedback('다른 탭에서 삭제된 하이라이트예요');
        return false;
      }
      if (result.status === 'unchanged') return true;
      if (result.status !== 'saved') {
        showFeedback('메모 저장 실패');
        return false;
      }
      const next = result.annotation;
      replaceAnnotations(annotationsRef.current.map((annotation) => (
        annotation.id === annotationId ? next : annotation
      )));
      setActiveHighlight((current) => current?.annotation.id === annotationId
        ? { ...current, annotation: next }
        : current);
      setUndoMutation({
        type: 'fields',
        patches: [{
          id: annotationId,
          fields: { note: result.before.note },
          expected: { note: next.note },
        }],
      });
      showFeedback(note.trim() ? '메모 저장됨' : '메모 삭제됨', true);
      return true;
    } catch (error) {
      console.warn('[EpubReader] Failed to update annotation note:', error);
      showFeedback('메모 저장 실패');
      return false;
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [bookId, ownerKey, replaceAnnotations, showFeedback, syncContext]);

  const changeAnnotationColors = useCallback(async (
    annotationIds: ReadonlyArray<string>,
    colorId: HighlightColorId,
  ) => {
    if (mutationInFlightRef.current) {
      showFeedback('진행 중인 하이라이트 작업이 끝난 뒤 다시 시도해 주세요');
      return false;
    }
    const ids = [...new Set(annotationIds.filter(Boolean))];
    if (ids.length === 0) return false;
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      const result = await updateLocalAnnotationColorsV8(
        ownerKey,
        bookId,
        ids,
        colorId,
        syncContext,
      );
      if (result.status === 'color-limit') {
        showFeedback(`${getHighlightColor(colorId).label} 하이라이트는 20개까지 저장할 수 있어요`);
        return false;
      }
      if (result.annotations.length === 0) {
        showFeedback('선택한 항목이 이미 같은 색이에요');
        return false;
      }
      const updatedById = new Map(result.annotations.map((annotation) => [annotation.id, annotation]));
      replaceAnnotations(annotationsRef.current.map((annotation) => (
        updatedById.get(annotation.id) ?? annotation
      )));
      setActiveHighlight((current) => current && updatedById.has(current.annotation.id)
        ? { ...current, annotation: updatedById.get(current.annotation.id) as Annotation }
        : current);
      const beforeById = new Map(result.before.map((annotation) => [annotation.id, annotation]));
      setUndoMutation({
        type: 'fields',
        patches: result.annotations.map((after) => ({
          id: after.id,
          fields: { colorId: beforeById.get(after.id)?.colorId ?? after.colorId },
          expected: { colorId: after.colorId },
        })),
      });
      showFeedback(`${result.annotations.length}개 색상 변경됨`, true);
      for (const annotation of result.annotations) {
        void renderAnnotation(annotation).catch((error) => {
          console.warn('[EpubReader] Failed to redraw recolored annotation:', error);
        });
      }
      return true;
    } catch (error) {
      console.warn('[EpubReader] Failed to recolor annotations:', error);
      showFeedback('색상 변경 실패');
      return false;
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [bookId, ownerKey, renderAnnotation, replaceAnnotations, showFeedback, syncContext]);

  const deleteAnnotations = useCallback(async (annotationIds: ReadonlyArray<string>) => {
    if (mutationInFlightRef.current) {
      showFeedback('진행 중인 하이라이트 작업이 끝난 뒤 다시 시도해 주세요');
      return false;
    }
    mutationInFlightRef.current = true;
    setIsMutating(true);
    try {
      const deleted = await deleteLocalAnnotationsV8(
        ownerKey,
        bookId,
        annotationIds,
        syncContext,
      );
      if (deleted.length === 0) return false;
      const deletedIds = new Set(deleted.map(({ id }) => id));
      replaceAnnotations(annotationsRef.current.filter(({ id }) => !deletedIds.has(id)));
      setActiveHighlight((current) => current && deletedIds.has(current.annotation.id) ? null : current);
      setUndoMutation({ type: 'delete', annotations: deleted });
      showFeedback(`${deleted.length}개 하이라이트 삭제됨`, true);
      for (const annotation of deleted) {
        void removeAnnotationOverlay(annotation).catch((error) => {
          console.warn('[EpubReader] Failed to remove deleted annotation overlay:', error);
        });
      }
      return true;
    } catch (error) {
      console.warn('[EpubReader] Failed to delete annotations:', error);
      showFeedback('하이라이트 삭제 실패');
      return false;
    } finally {
      mutationInFlightRef.current = false;
      setIsMutating(false);
    }
  }, [bookId, ownerKey, removeAnnotationOverlay, replaceAnnotations, showFeedback, syncContext]);

  const flashAnnotation = useCallback((annotationId: string) => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashCleanupRef.current?.();
    const elements = (viewRef.current?.renderer?.getContents?.() ?? [])
      .flatMap(({ overlayer }) => Array.from(
        overlayer?.element?.querySelectorAll('[data-reader-annotation-id]') ?? [],
      ))
      .filter((element) => element.getAttribute('data-reader-annotation-id') === annotationId) as SVGElement[];
    for (const element of elements) {
      element.setAttribute('data-reader-highlight-focus', 'true');
      element.style.transition = 'filter 160ms ease, opacity 160ms ease';
      element.style.filter = 'drop-shadow(0 0 5px currentColor)';
      element.style.opacity = '0.95';
    }
    const cleanup = () => {
      for (const element of elements) {
        element.removeAttribute('data-reader-highlight-focus');
        element.style.removeProperty('transition');
        element.style.removeProperty('filter');
        element.style.removeProperty('opacity');
      }
      if (flashCleanupRef.current === cleanup) flashCleanupRef.current = null;
    };
    flashCleanupRef.current = cleanup;
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      cleanup();
    }, 1800);
  }, [viewRef]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashCleanupRef.current?.();
  }, []);

  return {
    annotations,
    activeHighlight,
    feedback,
    canUndo: Boolean(undoMutation),
    isMutating,
    createHighlight,
    changeActiveColor,
    deleteActiveHighlight,
    updateAnnotationNote,
    changeAnnotationColors,
    deleteAnnotations,
    flashAnnotation,
    closeActiveHighlight,
    openHighlightAtPoint,
    undoLastMutation,
  };
};
