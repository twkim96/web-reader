'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ViewerSettings } from '../../types';
import type { FoliateViewElement } from '../foliate/types';
import type { ReaderTextSelection } from './useReaderTextSelection';
import {
  getBrowserSpeechErrorMessage,
  getBrowserSpeechSynthesisDependencies,
  isRetryableBrowserSpeechError,
  readBrowserSpeechVoices,
  startBrowserSpeech,
} from '../../lib/browserSpeechSynthesis';
import {
  READER_TTS_NAVIGATION_REASON,
  resolveReaderTtsLanguageTag,
  selectReaderTtsVoice,
  sortReaderTtsVoices,
} from '../../lib/readerTts';
import {
  createReaderTtsRangeQueue,
  createReaderTtsRangeSource,
  createReaderTtsRangeWindow,
  findVisibleReaderTtsAnchor,
  type ReaderTtsRangeSegment,
  type ReaderTtsRangeSource,
} from '../../lib/readerTtsRange';
import {
  createReaderTtsOverlayKey,
  drawReaderTtsRects,
} from '../../lib/readerTtsOverlay';
import {
  clearReaderTtsCursor,
  readReaderTtsCursor,
  saveReaderTtsCursor,
  type ReaderTtsCursor,
} from '../../lib/readerTtsCursor';
import {
  getDocumentFrameMetrics,
  mapFrameRectToViewport,
} from '../../lib/readerTextSelection';

export type ReaderTtsStatus = 'idle' | 'loading' | 'starting' | 'playing' | 'paused' | 'finished' | 'error';
export type ReaderTtsMode = 'selection' | 'position' | 'chapter';

export type ReaderTtsPresentationState = {
  status: ReaderTtsStatus;
  mode: ReaderTtsMode | null;
  index: number;
  total: number;
  text: string;
  error: string | null;
};

type ReaderTtsQueueItem = ReaderTtsRangeSegment & {
  sectionIndex: number;
  documentLanguage: string;
};

type ReaderTtsChapterQueue = {
  source: ReaderTtsRangeSource;
  sectionIndex: number;
};

type ReaderTtsQueue = {
  mode: ReaderTtsMode;
  items: ReaderTtsQueueItem[];
  index: number;
  autoAdvance: boolean;
  retryCount: number;
  chapter: ReaderTtsChapterQueue | null;
  windowed: ReaderTtsChapterQueue | null;
};

const CHAPTER_WINDOW_SIZE = 51;
const CHAPTER_WINDOW_BEFORE = 10;
const CHAPTER_FORWARD_SIZE = CHAPTER_WINDOW_SIZE - CHAPTER_WINDOW_BEFORE;
const CHAPTER_RETRY_DELAY_MS = 220;
const SPEECH_START_TIMEOUT_MS = 8_000;
const SELECTION_TTS_MAX_CHARACTERS = 50_000;

const idleState: ReaderTtsPresentationState = {
  status: 'idle',
  mode: null,
  index: 0,
  total: 0,
  text: '',
  error: null,
};

const toRange = (
  doc: Document,
  anchor: Range | Element | number | ((doc: Document) => Range | Element | number) | undefined,
) => {
  try {
    const resolved = typeof anchor === 'function' ? anchor(doc) : anchor;
    if (
      resolved
      && typeof resolved === 'object'
      && 'startContainer' in resolved
      && 'endContainer' in resolved
    ) return resolved as Range;
    if (resolved && typeof resolved === 'object' && 'nodeType' in resolved) {
      const range = doc.createRange();
      range.selectNodeContents(resolved as Element);
      return range;
    }
  } catch {
    // A persisted CFI can become stale after the publication changes.
  }
  return null;
};

const isRangeVisibleInReader = (range: Range) => {
  try {
    const doc = range.startContainer.ownerDocument;
    if (!doc) return false;
    const frame = getDocumentFrameMetrics(doc);
    return Array.from(range.getClientRects()).some((rect) => {
      const mapped = mapFrameRectToViewport(rect, frame);
      return mapped.width > 0
        && mapped.height > 0
        && mapped.right > 0
        && mapped.bottom > 0
        && mapped.left < window.innerWidth
        && mapped.top < window.innerHeight;
    });
  } catch {
    return false;
  }
};

const toQueueItems = (
  segments: ReaderTtsRangeSegment[],
  sectionIndex: number,
  documentLanguage: string,
): ReaderTtsQueueItem[] => segments.map((segment) => ({
  ...segment,
  sectionIndex,
  documentLanguage,
}));

export const useReaderTts = ({
  ownerKey,
  bookId,
  contentIdentity,
  enabled,
  isLoaded,
  viewRef,
  settings,
  clearSelection,
  dismissSelectionMenu,
  onProgressNavigationFenceChange,
}: {
  ownerKey: string;
  bookId: string;
  contentIdentity: string;
  enabled: boolean;
  isLoaded: boolean;
  viewRef: MutableRefObject<FoliateViewElement | null>;
  settings: ViewerSettings;
  clearSelection: () => void;
  dismissSelectionMenu: () => void;
  onProgressNavigationFenceChange: (active: boolean) => void;
}) => {
  const [state, setState] = useState<ReaderTtsPresentationState>(idleState);
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [feedback, setFeedback] = useState('');
  const [resumeCursor, setResumeCursor] = useState<ReaderTtsCursor | null>(() => (
    readReaderTtsCursor(ownerKey, bookId, undefined, contentIdentity)
  ));
  const [sleepTimerEndsAt, setSleepTimerEndsAt] = useState<number | null>(null);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<10 | 20 | 30 | null>(null);
  const stateRef = useRef(state);
  const queueRef = useRef<ReaderTtsQueue | null>(null);
  const overlayKeyRef = useRef(createReaderTtsOverlayKey());
  const overlayRef = useRef<{ index: number; view: FoliateViewElement } | null>(null);
  const generationRef = useRef(0);
  const desiredPlaybackRef = useRef<'playing' | 'paused'>('playing');
  const feedbackTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const sleepTimerRef = useRef<number | null>(null);
  const speechStartTimerRef = useRef<number | null>(null);
  const resumeValidationTimerRef = useRef<number | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const speechStartedGenerationRef = useRef<number | null>(null);
  const sleepTimerEndsAtRef = useRef<number | null>(null);
  const wasPlayingWhenHiddenRef = useRef(false);
  const speakIndexRef = useRef<(index: number, preserveRetry?: boolean) => void>(() => undefined);
  const advanceRef = useRef<() => void>(() => undefined);
  const finishChapterRef = useRef<() => void>(() => undefined);
  const stopRef = useRef<() => void>(() => undefined);

  stateRef.current = state;

  const showTtsFeedback = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setFeedback('');
    }, 2400);
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current === null) return;
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }, []);

  const clearSpeechStartTimer = useCallback(() => {
    if (speechStartTimerRef.current === null) return;
    window.clearTimeout(speechStartTimerRef.current);
    speechStartTimerRef.current = null;
  }, []);

  const clearResumeValidationTimer = useCallback(() => {
    if (resumeValidationTimerRef.current === null) return;
    window.clearTimeout(resumeValidationTimerRef.current);
    resumeValidationTimerRef.current = null;
  }, []);

  const clearSleepTimer = useCallback(() => {
    if (sleepTimerRef.current !== null) window.clearTimeout(sleepTimerRef.current);
    sleepTimerRef.current = null;
    sleepTimerEndsAtRef.current = null;
    setSleepTimerEndsAt(null);
    setSleepTimerMinutes(null);
  }, []);

  const clearOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    overlayRef.current = null;
    if (!overlay) return;
    try {
      overlay.view.removeTransientOverlay({
        key: overlayKeyRef.current,
        index: overlay.index,
      });
    } catch (error) {
      console.warn('[ReaderTts] failed to clear temporary overlay:', error);
    }
  }, []);

  const showOverlay = useCallback((item: ReaderTtsQueueItem, generation: number) => {
    const view = viewRef.current;
    if (!view) return;
    clearOverlay();
    if (generationRef.current !== generation || viewRef.current !== view) return;
    try {
      const added = view.addTransientOverlay({
        key: overlayKeyRef.current,
        index: item.sectionIndex,
        range: item.range,
        draw: drawReaderTtsRects,
        options: { color: '#38bdf8', interactive: false },
      });
      if (!added) return;
      overlayRef.current = { index: item.sectionIndex, view };
      if (generationRef.current !== generation || viewRef.current !== view) clearOverlay();
    } catch (error) {
      console.warn('[ReaderTts] failed to draw temporary overlay:', error);
    }
  }, [clearOverlay, viewRef]);

  const cancelSpeech = useCallback(() => {
    clearSpeechStartTimer();
    clearResumeValidationTimer();
    generationRef.current += 1;
    speechStartedGenerationRef.current = null;
    viewRef.current?.cancelTransientNavigation?.('tts');
    getBrowserSpeechSynthesisDependencies()?.synthesis.cancel();
    utteranceRef.current = null;
  }, [clearResumeValidationTimer, clearSpeechStartTimer, viewRef]);

  const stop = useCallback(() => {
    if (
      stateRef.current.mode === null
      && !queueRef.current
      && !overlayRef.current
      && retryTimerRef.current === null
      && sleepTimerRef.current === null
    ) {
      onProgressNavigationFenceChange(false);
      return;
    }
    clearRetryTimer();
    clearSpeechStartTimer();
    clearResumeValidationTimer();
    clearSleepTimer();
    cancelSpeech();
    queueRef.current = null;
    desiredPlaybackRef.current = 'playing';
    setState(idleState);
    clearOverlay();
    onProgressNavigationFenceChange(false);
  }, [cancelSpeech, clearOverlay, clearResumeValidationTimer, clearRetryTimer, clearSleepTimer, clearSpeechStartTimer, onProgressNavigationFenceChange]);

  stopRef.current = stop;

  const saveChapterCursor = useCallback((queue: ReaderTtsQueue, item: ReaderTtsQueueItem) => {
    if (queue.mode !== 'chapter') return;
    const view = viewRef.current;
    if (!view) return;
    try {
      const cfi = view.getCFI(item.sectionIndex, item.range);
      const cursor: ReaderTtsCursor = {
        ownerKey,
        bookId,
        sectionIndex: item.sectionIndex,
        sourceIndex: item.sourceIndex,
        cfi,
        text: item.text.slice(0, 1_000),
        contentIdentity,
        updatedAt: Date.now(),
      };
      if (saveReaderTtsCursor(cursor)) setResumeCursor(cursor);
    } catch (error) {
      console.warn('[ReaderTts] failed to persist chapter cursor:', error);
    }
  }, [bookId, contentIdentity, ownerKey, viewRef]);

  const clearChapterCursor = useCallback(() => {
    clearReaderTtsCursor(ownerKey, bookId);
    setResumeCursor(null);
  }, [bookId, ownerKey]);

  const ensureChapterItemVisible = useCallback((
    queue: ReaderTtsQueue,
    item: ReaderTtsQueueItem,
    generation: number,
  ) => {
    if (queue.mode !== 'chapter' || isRangeVisibleInReader(item.range)) return;
    const view = viewRef.current;
    if (!view) return;
    void view.navigateTransient({
      index: item.sectionIndex,
      range: item.range,
    }, READER_TTS_NAVIGATION_REASON).catch((error) => {
      if (generationRef.current === generation) {
        console.warn('[ReaderTts] failed to follow spoken sentence:', error);
      }
    });
  }, [viewRef]);

  const setFinishedState = useCallback((queue: ReaderTtsQueue) => {
    const item = queue.items[queue.index];
    const windowed = queue.windowed;
    setState((current) => ({
      ...current,
      status: 'finished',
      index: windowed && item ? item.sourceIndex : current.index,
      total: windowed ? windowed.source.segments.length : current.total,
      error: null,
    }));
    generationRef.current += 1;
    clearResumeValidationTimer();
    clearRetryTimer();
    clearSleepTimer();
    clearOverlay();
  }, [clearOverlay, clearResumeValidationTimer, clearRetryTimer, clearSleepTimer]);

  const continueToNextSection = useCallback(async (queue: ReaderTtsQueue) => {
    const chapter = queue.chapter;
    const view = viewRef.current;
    if (!chapter || !view) {
      setFinishedState(queue);
      return;
    }
    const sections = view.book?.sections ?? [];
    const nextIndexes = sections.flatMap((section, index) => (
      index > chapter.sectionIndex && section.linear !== 'no' ? [index] : []
    ));
    if (nextIndexes.length === 0) {
      clearChapterCursor();
      setFinishedState(queue);
      return;
    }
    const transitionGeneration = generationRef.current + 1;
    generationRef.current = transitionGeneration;
    clearOverlay();
    setState((current) => ({
      ...current,
      status: 'loading',
      text: '다음 장을 준비하고 있습니다',
      error: null,
    }));
    try {
      for (const nextIndex of nextIndexes) {
        await view.navigateTransient({ index: nextIndex }, READER_TTS_NAVIGATION_REASON);
        if (generationRef.current !== transitionGeneration || viewRef.current !== view) return;
        const content = view.renderer?.getContents?.().find(({ index }) => index === nextIndex);
        const doc = content?.doc;
        if (!doc) throw new Error('next-section-content-unavailable');
        const source = createReaderTtsRangeSource({
          doc,
          locale: doc.documentElement.lang || undefined,
        });
        const window = createReaderTtsRangeWindow({
          source,
          startIndex: 0,
          maxSegments: CHAPTER_WINDOW_SIZE,
        });
        if (window.segments.length === 0) continue;
        const nextQueue: ReaderTtsQueue = {
          mode: 'chapter',
          items: toQueueItems(window.segments, nextIndex, doc.documentElement.lang),
          index: window.initialIndex,
          autoAdvance: true,
          retryCount: 0,
          chapter: { source, sectionIndex: nextIndex },
          windowed: { source, sectionIndex: nextIndex },
        };
        queueRef.current = nextQueue;
        speakIndexRef.current(nextQueue.index);
        return;
      }
      clearChapterCursor();
      setFinishedState(queue);
    } catch {
      if (generationRef.current !== transitionGeneration) return;
      setState((current) => ({
        ...current,
        status: 'error',
        error: '다음 장을 불러오지 못했습니다.',
      }));
      showTtsFeedback('다음 장을 불러오지 못했습니다');
      clearSleepTimer();
    }
  }, [clearChapterCursor, clearOverlay, clearSleepTimer, setFinishedState, showTtsFeedback, viewRef]);

  const finishChapter = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || queue.mode !== 'chapter') return;
    if (settings.ttsChapterEndAction === 'next') {
      void continueToNextSection(queue);
      return;
    }
    clearChapterCursor();
    setFinishedState(queue);
  }, [clearChapterCursor, continueToNextSection, setFinishedState, settings.ttsChapterEndAction]);

  finishChapterRef.current = finishChapter;

  const speakIndex = useCallback((index: number, preserveRetry = false) => {
    const queue = queueRef.current;
    const dependencies = getBrowserSpeechSynthesisDependencies();
    if (!queue || !dependencies) {
      showTtsFeedback('이 브라우저에서는 TTS를 지원하지 않습니다');
      stop();
      return;
    }
    const nextIndex = Math.min(queue.items.length - 1, Math.max(0, index));
    const item = queue.items[nextIndex];
    if (!item) {
      stop();
      return;
    }
    onProgressNavigationFenceChange(true);
    clearRetryTimer();
    clearSpeechStartTimer();
    clearResumeValidationTimer();
    if (!preserveRetry) queue.retryCount = 0;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    speechStartedGenerationRef.current = null;
    desiredPlaybackRef.current = 'playing';
    if (
      dependencies.synthesis.speaking === true
      || dependencies.synthesis.pending === true
      || dependencies.synthesis.paused === true
    ) dependencies.synthesis.cancel();
    utteranceRef.current = null;
    queue.index = nextIndex;
    const language = resolveReaderTtsLanguageTag({
      configured: settings.ttsLanguage,
      text: item.text,
      documentLanguage: item.documentLanguage,
    });
    const voice = selectReaderTtsVoice(voices, settings.ttsVoiceURI, language);
    const windowed = queue.windowed;
    setState({
      status: 'starting',
      mode: queue.mode,
      index: windowed ? item.sourceIndex : nextIndex,
      total: windowed ? windowed.source.segments.length : queue.items.length,
      text: item.text,
      error: null,
    });
    ensureChapterItemVisible(queue, item, generation);
    showOverlay(item, generation);
    saveChapterCursor(queue, item);

    const handleFailure = (error: unknown) => {
      if (generationRef.current !== generation) return;
      clearSpeechStartTimer();
      clearResumeValidationTimer();
      utteranceRef.current = null;
      if (queue.mode === 'chapter' && isRetryableBrowserSpeechError(error)) {
        generationRef.current += 1;
        clearOverlay();
        if (queue.retryCount < 1) {
          queue.retryCount += 1;
          setState((current) => ({
            ...current,
            status: 'loading',
            error: '음성 재생을 다시 시도합니다.',
          }));
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            if (queueRef.current === queue) speakIndexRef.current(queue.index, true);
          }, CHAPTER_RETRY_DELAY_MS);
          return;
        }
        queue.retryCount = 0;
        showTtsFeedback('재생하지 못한 문장을 건너뜁니다');
        setState((current) => ({
          ...current,
          status: 'loading',
          error: '다음 문장으로 이동합니다.',
        }));
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (queueRef.current === queue) advanceRef.current();
        }, CHAPTER_RETRY_DELAY_MS);
        return;
      }
      setState((current) => ({
        ...current,
        status: 'error',
        error: getBrowserSpeechErrorMessage(error),
      }));
      generationRef.current += 1;
      clearSleepTimer();
      clearOverlay();
    };

    try {
      speechStartTimerRef.current = window.setTimeout(() => {
        speechStartTimerRef.current = null;
        if (generationRef.current !== generation) return;
        dependencies.synthesis.cancel();
        handleFailure(new Error('speech-start-timeout'));
      }, SPEECH_START_TIMEOUT_MS);
      utteranceRef.current = startBrowserSpeech({
        text: item.text,
        language,
        rate: settings.ttsRate,
        voice,
        onStart: () => {
          if (generationRef.current !== generation) return;
          clearSpeechStartTimer();
          clearResumeValidationTimer();
          speechStartedGenerationRef.current = generation;
          if (desiredPlaybackRef.current === 'paused') {
            dependencies.synthesis.pause();
            setState((current) => ({ ...current, status: 'paused', error: null }));
            return;
          }
          setState((current) => ({ ...current, status: 'playing', error: null }));
        },
        onEnd: () => {
          if (generationRef.current !== generation) return;
          clearSpeechStartTimer();
          clearResumeValidationTimer();
          utteranceRef.current = null;
          queue.retryCount = 0;
          if (queue.autoAdvance) {
            advanceRef.current();
            return;
          }
          setFinishedState(queue);
        },
        onError: handleFailure,
      }, dependencies);
    } catch (error) {
      handleFailure(error);
    }
  }, [
    clearOverlay,
    clearRetryTimer,
    clearResumeValidationTimer,
    clearSleepTimer,
    clearSpeechStartTimer,
    ensureChapterItemVisible,
    onProgressNavigationFenceChange,
    saveChapterCursor,
    setFinishedState,
    settings.ttsLanguage,
    settings.ttsRate,
    settings.ttsVoiceURI,
    showOverlay,
    showTtsFeedback,
    stop,
    voices,
  ]);

  speakIndexRef.current = speakIndex;

  const advance = useCallback(() => {
    const queue = queueRef.current;
    if (!queue) return;
    if (queue.index + 1 < queue.items.length) {
      speakIndexRef.current(queue.index + 1);
      return;
    }
    const windowed = queue.windowed;
    const current = queue.items[queue.index];
    if (!windowed || !current) {
      setFinishedState(queue);
      return;
    }
    const window = createReaderTtsRangeWindow({
      source: windowed.source,
      startIndex: current.sourceIndex + 1,
      maxSegments: CHAPTER_FORWARD_SIZE,
    });
    if (window.segments.length === 0) {
      if (queue.mode === 'chapter') finishChapterRef.current();
      else setFinishedState(queue);
      return;
    }
    const keep = queue.items.slice(
      Math.max(0, queue.index - CHAPTER_WINDOW_BEFORE + 1),
      queue.index + 1,
    );
    queue.items = [
      ...keep,
      ...toQueueItems(
        window.segments,
        windowed.sectionIndex,
        windowed.source.doc.documentElement.lang,
      ),
    ];
    queue.index = keep.length - 1;
    speakIndexRef.current(queue.index + 1);
  }, [setFinishedState]);

  advanceRef.current = advance;

  const previous = useCallback(() => {
    const queue = queueRef.current;
    if (!queue) return;
    if (queue.index > 0) {
      speakIndexRef.current(queue.index - 1);
      return;
    }
    const windowed = queue.windowed;
    const current = queue.items[queue.index];
    if (!windowed || !current || current.sourceIndex <= 0) return;
    const window = createReaderTtsRangeWindow({
      source: windowed.source,
      startIndex: current.sourceIndex - 1,
      maxSegments: CHAPTER_WINDOW_SIZE,
      windowBefore: CHAPTER_FORWARD_SIZE - 1,
    });
    if (window.segments.length === 0) return;
    queue.items = toQueueItems(
      window.segments,
      windowed.sectionIndex,
      windowed.source.doc.documentElement.lang,
    );
    queue.index = window.initialIndex;
    speakIndexRef.current(queue.index);
  }, []);

  const next = useCallback(() => {
    const queue = queueRef.current;
    if (!queue) return;
    if (queue.windowed) {
      cancelSpeech();
      advanceRef.current();
      return;
    }
    if (queue.index + 1 < queue.items.length) speakIndexRef.current(queue.index + 1);
  }, [cancelSpeech]);

  const beginQueue = useCallback((
    mode: Exclude<ReaderTtsMode, 'chapter'>,
    items: ReaderTtsQueueItem[],
    initialIndex: number,
  ) => {
    if (items.length === 0) {
      showTtsFeedback('읽을 수 있는 문장을 찾지 못했습니다');
      return false;
    }
    queueRef.current = {
      mode,
      items,
      index: initialIndex,
      autoAdvance: mode === 'selection',
      retryCount: 0,
      chapter: null,
      windowed: null,
    };
    speakIndexRef.current(initialIndex);
    return true;
  }, [showTtsFeedback]);

  const beginChapterQueue = useCallback((
    doc: Document,
    sectionIndex: number,
    anchorRange?: Range,
    startIndex?: number,
    expectedText?: string,
  ) => {
    const source = createReaderTtsRangeSource({
      doc,
      locale: doc.documentElement.lang || undefined,
    });
    const window = createReaderTtsRangeWindow({
      source,
      anchorRange,
      startIndex: anchorRange ? undefined : startIndex,
      maxSegments: CHAPTER_WINDOW_SIZE,
      windowBefore: CHAPTER_WINDOW_BEFORE,
    });
    if (window.segments.length === 0) {
      showTtsFeedback('현재 장에서 읽을 문장을 찾지 못했습니다');
      return false;
    }
    const initialSegment = window.segments[window.initialIndex];
    if (
      expectedText
      && initialSegment
      && initialSegment.text.replaceAll(/\s+/gu, ' ').trim()
        !== expectedText.replaceAll(/\s+/gu, ' ').trim()
    ) {
      clearChapterCursor();
      showTtsFeedback('저장한 TTS 위치가 현재 도서 내용과 달라 삭제했습니다');
      return false;
    }
    const queue: ReaderTtsQueue = {
      mode: 'chapter',
      items: toQueueItems(window.segments, sectionIndex, doc.documentElement.lang),
      index: window.initialIndex,
      autoAdvance: true,
      retryCount: 0,
      chapter: { source, sectionIndex },
      windowed: { source, sectionIndex },
    };
    queueRef.current = queue;
    speakIndexRef.current(queue.index);
    return true;
  }, [clearChapterCursor, showTtsFeedback]);

  const getCurrentContent = useCallback(() => {
    const view = viewRef.current;
    const contents = view?.renderer?.getContents?.() ?? [];
    if (!view || contents.length === 0) return null;
    const locationRange = view.lastLocation?.range;
    const locationDocument = locationRange?.startContainer.ownerDocument;
    const content = contents.find(({ doc }) => doc === locationDocument)
      ?? contents.find(({ doc }) => Boolean(doc));
    const doc = content?.doc;
    if (!doc) return null;
    const sectionIndex = content.index
      ?? view.resolveNavigation(view.lastLocation?.cfi ?? '')?.index
      ?? -1;
    if (sectionIndex < 0) return null;
    return {
      view,
      doc,
      sectionIndex,
      anchorRange: locationDocument === doc
        ? locationRange
        : findVisibleReaderTtsAnchor(doc) ?? undefined,
    };
  }, [viewRef]);

  const speakSelection = useCallback((selection: ReaderTextSelection) => {
    if (!supported || !enabled) {
      showTtsFeedback('이 브라우저에서는 TTS를 지원하지 않습니다');
      return false;
    }
    const doc = selection.range.startContainer.ownerDocument;
    if (!doc || selection.index < 0) {
      showTtsFeedback('선택한 범위를 읽을 수 없습니다');
      return false;
    }
    if (selection.text.length > SELECTION_TTS_MAX_CHARACTERS) {
      showTtsFeedback('선택 영역 듣기는 5만 자까지 지원합니다');
      return false;
    }
    const source = createReaderTtsRangeSource({
      doc,
      scopeRange: selection.range,
      locale: doc.documentElement.lang || undefined,
    });
    const window = createReaderTtsRangeWindow({
      source,
      startIndex: 0,
      maxSegments: CHAPTER_WINDOW_SIZE,
    });
    const started = window.segments.length > 0;
    if (started) {
      const queue: ReaderTtsQueue = {
        mode: 'selection',
        items: toQueueItems(window.segments, selection.index, doc.documentElement.lang),
        index: window.initialIndex,
        autoAdvance: true,
        retryCount: 0,
        chapter: null,
        windowed: { source, sectionIndex: selection.index },
      };
      queueRef.current = queue;
      speakIndexRef.current(queue.index);
      dismissSelectionMenu();
      clearSelection();
    } else {
      showTtsFeedback('읽을 수 있는 문장을 찾지 못했습니다');
    }
    return started;
  }, [clearSelection, dismissSelectionMenu, enabled, showTtsFeedback, supported]);

  const speakFromCurrentPosition = useCallback(() => {
    if (!supported || !enabled || !isLoaded) {
      showTtsFeedback('이 브라우저에서는 TTS를 지원하지 않습니다');
      return false;
    }
    const current = getCurrentContent();
    if (!current) {
      showTtsFeedback('현재 위치에서 읽을 문장을 찾지 못했습니다');
      return false;
    }
    let queue = createReaderTtsRangeQueue({
      doc: current.doc,
      anchorRange: current.anchorRange,
      locale: current.doc.documentElement.lang || undefined,
      maxSegments: 21,
      windowBefore: 10,
    });
    if (queue.segments.length === 0 && current.anchorRange) {
      queue = createReaderTtsRangeQueue({
        doc: current.doc,
        anchorRange: findVisibleReaderTtsAnchor(current.doc) ?? undefined,
        locale: current.doc.documentElement.lang || undefined,
        maxSegments: 21,
        windowBefore: 10,
      });
    }
    const started = beginQueue(
      'position',
      toQueueItems(queue.segments, current.sectionIndex, current.doc.documentElement.lang),
      queue.initialIndex,
    );
    if (started) clearSelection();
    return started;
  }, [beginQueue, clearSelection, enabled, getCurrentContent, isLoaded, showTtsFeedback, supported]);

  const speakChapterFromCurrentPosition = useCallback(() => {
    if (!supported || !enabled || !isLoaded) {
      showTtsFeedback('이 브라우저에서는 TTS를 지원하지 않습니다');
      return false;
    }
    const current = getCurrentContent();
    if (!current) {
      showTtsFeedback('현재 장을 불러오지 못했습니다');
      return false;
    }
    const started = beginChapterQueue(
      current.doc,
      current.sectionIndex,
      current.anchorRange,
    );
    if (started) clearSelection();
    return started;
  }, [beginChapterQueue, clearSelection, enabled, getCurrentContent, isLoaded, showTtsFeedback, supported]);

  const resumeChapter = useCallback(async () => {
    const cursor = resumeCursor;
    const view = viewRef.current;
    if (!cursor || !view || !supported || !enabled || !isLoaded) {
      showTtsFeedback('이어 들을 TTS 위치가 없습니다');
      return false;
    }
    stop();
    const transitionGeneration = generationRef.current + 1;
    generationRef.current = transitionGeneration;
    setState({
      status: 'loading',
      mode: 'chapter',
      index: cursor.sourceIndex,
      total: 0,
      text: cursor.text || '저장 위치를 준비하고 있습니다',
      error: null,
    });
    try {
      const resolved = view.resolveNavigation(cursor.cfi);
      const sectionIndex = resolved?.index ?? cursor.sectionIndex;
      let content = view.renderer?.getContents?.().find(({ index }) => index === sectionIndex);
      let restoredFromCfi = Boolean(content?.doc && resolved);
      if (!content?.doc) {
        const targets: Array<string | { index: number }> = resolved
          ? [cursor.cfi, { index: cursor.sectionIndex }]
          : [{ index: cursor.sectionIndex }];
        for (const target of targets) {
          try {
            await view.navigateTransient(target, READER_TTS_NAVIGATION_REASON);
          } catch {
            continue;
          }
          if (generationRef.current !== transitionGeneration || viewRef.current !== view) return false;
          content = view.renderer?.getContents?.().find(({ index }) => (
            index === (typeof target === 'string' ? sectionIndex : target.index)
          ));
          if (content?.doc) {
            restoredFromCfi = typeof target === 'string';
            break;
          }
        }
      }
      const loadedContent = content;
      const doc = loadedContent?.doc;
      if (!loadedContent || !doc) throw new Error('cursor-content-unavailable');
      const resolvedAnchorRange = restoredFromCfi && loadedContent.index === resolved?.index
        ? toRange(doc, resolved?.anchor)
        : null;
      const anchorRange = resolvedAnchorRange ?? undefined;
      if (generationRef.current !== transitionGeneration) return false;
      const started = beginChapterQueue(
        doc,
        loadedContent.index ?? cursor.sectionIndex,
        anchorRange,
        cursor.sourceIndex,
        cursor.text,
      );
      if (!started) throw new Error('cursor-range-unavailable');
      clearSelection();
      return true;
    } catch {
      if (generationRef.current !== transitionGeneration) return false;
      setState((current) => ({
        ...current,
        status: 'error',
        error: '저장한 TTS 위치를 복원하지 못했습니다.',
      }));
      showTtsFeedback('저장한 TTS 위치를 복원하지 못했습니다');
      return false;
    }
  }, [
    beginChapterQueue,
    clearSelection,
    enabled,
    isLoaded,
    resumeCursor,
    showTtsFeedback,
    stop,
    supported,
    viewRef,
  ]);

  const togglePause = useCallback(() => {
    const dependencies = getBrowserSpeechSynthesisDependencies();
    const queue = queueRef.current;
    if (!dependencies || !queue) return;
    if (state.status === 'playing' || state.status === 'starting' || state.status === 'loading') {
      desiredPlaybackRef.current = 'paused';
      clearSpeechStartTimer();
      clearResumeValidationTimer();
      dependencies.synthesis.pause();
      setState((current) => ({ ...current, status: 'paused' }));
      return;
    }
    if (state.status === 'paused') {
      desiredPlaybackRef.current = 'playing';
      if (speechStartedGenerationRef.current !== generationRef.current) {
        speakIndexRef.current(queue.index);
        return;
      }
      dependencies.synthesis.resume();
      setState((current) => ({ ...current, status: 'loading' }));
      clearResumeValidationTimer();
      const generation = generationRef.current;
      const queueIndex = queue.index;
      resumeValidationTimerRef.current = window.setTimeout(() => {
        resumeValidationTimerRef.current = null;
        if (
          generationRef.current !== generation
          || desiredPlaybackRef.current !== 'playing'
          || queueRef.current !== queue
          || queue.index !== queueIndex
          || stateRef.current.status !== 'loading'
        ) return;
        if (dependencies.synthesis.paused) {
          setState((current) => ({ ...current, status: 'paused' }));
          return;
        }
        if (dependencies.synthesis.speaking || dependencies.synthesis.pending) {
          setState((current) => ({ ...current, status: 'playing' }));
          return;
        }
        speakIndexRef.current(queueIndex);
      }, 120);
      return;
    }
    speakIndexRef.current(queue.index);
  }, [clearResumeValidationTimer, clearSpeechStartTimer, state.status]);

  const setSleepTimer = useCallback((minutes: 0 | 10 | 20 | 30) => {
    clearSleepTimer();
    if (minutes === 0) return;
    const endsAt = Date.now() + minutes * 60_000;
    sleepTimerEndsAtRef.current = endsAt;
    setSleepTimerEndsAt(endsAt);
    setSleepTimerMinutes(minutes);
    sleepTimerRef.current = window.setTimeout(() => {
      sleepTimerRef.current = null;
      sleepTimerEndsAtRef.current = null;
      setSleepTimerEndsAt(null);
      setSleepTimerMinutes(null);
      showTtsFeedback('취침 타이머로 TTS를 중지했습니다');
      stopRef.current();
    }, minutes * 60_000);
  }, [clearSleepTimer, showTtsFeedback]);

  useEffect(() => {
    const dependencies = getBrowserSpeechSynthesisDependencies();
    setSupported(Boolean(dependencies));
    if (!dependencies) {
      setVoices([]);
      return;
    }
    let active = true;
    const updateVoices = () => {
      if (!active) return;
      setVoices(sortReaderTtsVoices(readBrowserSpeechVoices(dependencies)));
    };
    updateVoices();
    dependencies.synthesis.addEventListener('voiceschanged', updateVoices);
    return () => {
      active = false;
      dependencies.synthesis.removeEventListener('voiceschanged', updateVoices);
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const dependencies = getBrowserSpeechSynthesisDependencies();
      if (document.visibilityState === 'hidden') {
        wasPlayingWhenHiddenRef.current = stateRef.current.status === 'playing';
        return;
      }
      if (
        sleepTimerEndsAtRef.current !== null
        && Date.now() >= sleepTimerEndsAtRef.current
      ) {
        showTtsFeedback('취침 타이머로 TTS를 중지했습니다');
        stopRef.current();
        return;
      }
      const queue = queueRef.current;
      if (!dependencies || !queue) return;
      if (dependencies.synthesis.paused === true) {
        desiredPlaybackRef.current = 'paused';
        wasPlayingWhenHiddenRef.current = false;
        setState((current) => ({ ...current, status: 'paused' }));
        return;
      }
      if (
        wasPlayingWhenHiddenRef.current
        && stateRef.current.status === 'playing'
        && dependencies.synthesis.speaking === false
        && dependencies.synthesis.pending === false
      ) {
        showTtsFeedback('중단된 음성을 현재 문장에서 다시 시작합니다');
        speakIndexRef.current(queue.index);
      }
      wasPlayingWhenHiddenRef.current = false;
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [showTtsFeedback]);

  useEffect(() => {
    setResumeCursor(readReaderTtsCursor(ownerKey, bookId, undefined, contentIdentity));
    return () => {
      generationRef.current += 1;
      speechStartedGenerationRef.current = null;
      getBrowserSpeechSynthesisDependencies()?.synthesis.cancel();
      utteranceRef.current = null;
      queueRef.current = null;
      clearRetryTimer();
      clearSpeechStartTimer();
      clearResumeValidationTimer();
      clearSleepTimer();
      clearOverlay();
      onProgressNavigationFenceChange(false);
    };
  }, [bookId, clearOverlay, clearResumeValidationTimer, clearRetryTimer, clearSleepTimer, clearSpeechStartTimer, contentIdentity, onProgressNavigationFenceChange, ownerKey]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const queue = queueRef.current;
  const currentItem = queue?.items[queue.index];
  const canPrevious = Boolean(queue && (
    queue.index > 0
    || (queue.windowed && (currentItem?.sourceIndex ?? 0) > 0)
  ));
  const canNext = Boolean(queue && (
    queue.index + 1 < queue.items.length
    || (queue.windowed && (
      (currentItem?.sourceIndex ?? 0) + 1 < queue.windowed.source.segments.length
      || (queue.mode === 'chapter' && settings.ttsChapterEndAction === 'next')
    ))
  ));

  return {
    state,
    feedback,
    supported,
    voices,
    resumeCursor,
    sleepTimerEndsAt,
    sleepTimerMinutes,
    canPrevious,
    canNext,
    windowSize: queue?.items.length ?? 0,
    speakSelection,
    speakFromCurrentPosition,
    speakChapterFromCurrentPosition,
    resumeChapter,
    togglePause,
    previous,
    next,
    stop,
    setSleepTimer,
  };
};
