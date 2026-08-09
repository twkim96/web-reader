'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { ViewerSettings } from '../../types';
import type {
  FoliateViewElement,
} from '../foliate/types';
import type { ReaderTextSelection } from './useReaderTextSelection';
import {
  getBrowserSpeechErrorMessage,
  getBrowserSpeechSynthesisDependencies,
  readBrowserSpeechVoices,
  startBrowserSpeech,
} from '../../lib/browserSpeechSynthesis';
import {
  resolveReaderTtsLanguageTag,
  selectReaderTtsVoice,
  sortReaderTtsVoices,
} from '../../lib/readerTts';
import {
  createReaderTtsRangeQueue,
  findVisibleReaderTtsAnchor,
  type ReaderTtsRangeSegment,
} from '../../lib/readerTtsRange';
import {
  createReaderTtsOverlayKey,
  drawReaderTtsRects,
} from '../../lib/readerTtsOverlay';

export type ReaderTtsStatus = 'idle' | 'playing' | 'paused' | 'finished' | 'error';
export type ReaderTtsMode = 'selection' | 'position';

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

type ReaderTtsQueue = {
  mode: ReaderTtsMode;
  items: ReaderTtsQueueItem[];
  index: number;
  autoAdvance: boolean;
};

const idleState: ReaderTtsPresentationState = {
  status: 'idle',
  mode: null,
  index: 0,
  total: 0,
  text: '',
  error: null,
};

export const useReaderTts = ({
  bookId,
  enabled,
  isLoaded,
  viewRef,
  settings,
  clearSelection,
  dismissSelectionMenu,
}: {
  bookId: string;
  enabled: boolean;
  isLoaded: boolean;
  viewRef: MutableRefObject<FoliateViewElement | null>;
  settings: ViewerSettings;
  clearSelection: () => void;
  dismissSelectionMenu: () => void;
}) => {
  const [state, setState] = useState<ReaderTtsPresentationState>(idleState);
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [feedback, setFeedback] = useState('');
  const queueRef = useRef<ReaderTtsQueue | null>(null);
  const overlayKeyRef = useRef(createReaderTtsOverlayKey());
  const overlayRef = useRef<{ index: number; view: FoliateViewElement } | null>(null);
  const generationRef = useRef(0);
  const desiredPlaybackRef = useRef<'playing' | 'paused'>('playing');
  const feedbackTimerRef = useRef<number | null>(null);
  const speakIndexRef = useRef<(index: number) => void>(() => undefined);

  const showTtsFeedback = useCallback((message: string) => {
    setFeedback(message);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setFeedback('');
    }, 2400);
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
    generationRef.current += 1;
    getBrowserSpeechSynthesisDependencies()?.synthesis.cancel();
  }, []);

  const stop = useCallback(() => {
    if (!queueRef.current && !overlayRef.current) return;
    cancelSpeech();
    queueRef.current = null;
    desiredPlaybackRef.current = 'playing';
    setState(idleState);
    clearOverlay();
  }, [cancelSpeech, clearOverlay]);

  const speakIndex = useCallback((index: number) => {
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
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    desiredPlaybackRef.current = 'playing';
    dependencies.synthesis.cancel();
    queue.index = nextIndex;
    const language = resolveReaderTtsLanguageTag({
      configured: settings.ttsLanguage,
      text: item.text,
      documentLanguage: item.documentLanguage,
    });
    const voice = selectReaderTtsVoice(
      voices,
      settings.ttsVoiceURI,
      language,
    );
    setState({
      status: 'playing',
      mode: queue.mode,
      index: nextIndex,
      total: queue.items.length,
      text: item.text,
      error: null,
    });
    showOverlay(item, generation);
    try {
      startBrowserSpeech({
        text: item.text,
        language,
        rate: settings.ttsRate,
        voice,
        onStart: () => {
          if (generationRef.current !== generation) return;
          if (desiredPlaybackRef.current === 'paused') {
            dependencies.synthesis.pause();
            setState((current) => ({ ...current, status: 'paused', error: null }));
            return;
          }
          setState((current) => ({ ...current, status: 'playing', error: null }));
        },
        onEnd: () => {
          if (generationRef.current !== generation) return;
          const currentQueue = queueRef.current;
          if (
            currentQueue?.autoAdvance
            && currentQueue.index === nextIndex
            && nextIndex + 1 < currentQueue.items.length
          ) {
            speakIndexRef.current(nextIndex + 1);
            return;
          }
          setState((current) => ({ ...current, status: 'finished' }));
          generationRef.current += 1;
          clearOverlay();
        },
        onError: (error) => {
          if (generationRef.current !== generation) return;
          setState((current) => ({
            ...current,
            status: 'error',
            error: getBrowserSpeechErrorMessage(error),
          }));
          generationRef.current += 1;
          clearOverlay();
        },
      }, dependencies);
    } catch (error) {
      if (generationRef.current !== generation) return;
      setState((current) => ({
        ...current,
        status: 'error',
        error: getBrowserSpeechErrorMessage(error),
      }));
      generationRef.current += 1;
      clearOverlay();
    }
  }, [clearOverlay, settings.ttsLanguage, settings.ttsRate, settings.ttsVoiceURI, showOverlay, showTtsFeedback, stop, voices]);

  speakIndexRef.current = speakIndex;

  const beginQueue = useCallback((
    mode: ReaderTtsMode,
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
    };
    speakIndexRef.current(initialIndex);
    return true;
  }, [showTtsFeedback]);

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
    const queue = createReaderTtsRangeQueue({
      doc,
      scopeRange: selection.range,
      anchorRange: selection.range,
      locale: doc.documentElement.lang || undefined,
    });
    const started = beginQueue(
      'selection',
      queue.segments.map((segment) => ({
        ...segment,
        sectionIndex: selection.index,
        documentLanguage: doc.documentElement.lang,
      })),
      queue.initialIndex,
    );
    if (started) {
      dismissSelectionMenu();
      clearSelection();
    }
    return started;
  }, [beginQueue, clearSelection, dismissSelectionMenu, enabled, showTtsFeedback, supported]);

  const speakFromCurrentPosition = useCallback(() => {
    if (!supported || !enabled || !isLoaded) {
      showTtsFeedback('이 브라우저에서는 TTS를 지원하지 않습니다');
      return false;
    }
    const view = viewRef.current;
    const contents = view?.renderer?.getContents?.() ?? [];
    if (!view || contents.length === 0) {
      showTtsFeedback('현재 위치에서 읽을 문장을 찾지 못했습니다');
      return false;
    }
    const locationRange = view.lastLocation?.range;
    const locationDocument = locationRange?.startContainer.ownerDocument;
    const content = contents.find(({ doc }) => doc === locationDocument)
      ?? contents.find(({ doc }) => Boolean(doc));
    const doc = content?.doc;
    if (!doc) {
      showTtsFeedback('현재 위치에서 읽을 문장을 찾지 못했습니다');
      return false;
    }
    const anchorRange = locationDocument === doc
      ? locationRange
      : findVisibleReaderTtsAnchor(doc) ?? undefined;
    const resolvedIndex = content.index
      ?? view.resolveNavigation(view.lastLocation?.cfi ?? '')?.index
      ?? -1;
    if (resolvedIndex < 0) {
      showTtsFeedback('현재 문장의 위치를 확인하지 못했습니다');
      return false;
    }
    let queue = createReaderTtsRangeQueue({
      doc,
      anchorRange,
      locale: doc.documentElement.lang || undefined,
      maxSegments: 21,
      windowBefore: 10,
    });
    if (queue.segments.length === 0 && anchorRange) {
      queue = createReaderTtsRangeQueue({
        doc,
        anchorRange: findVisibleReaderTtsAnchor(doc) ?? undefined,
        locale: doc.documentElement.lang || undefined,
        maxSegments: 21,
        windowBefore: 10,
      });
    }
    const started = beginQueue(
      'position',
      queue.segments.map((segment) => ({
        ...segment,
        sectionIndex: resolvedIndex,
        documentLanguage: doc.documentElement.lang,
      })),
      queue.initialIndex,
    );
    if (started) clearSelection();
    return started;
  }, [beginQueue, clearSelection, enabled, isLoaded, showTtsFeedback, supported, viewRef]);

  const togglePause = useCallback(() => {
    const dependencies = getBrowserSpeechSynthesisDependencies();
    const queue = queueRef.current;
    if (!dependencies || !queue) return;
    if (state.status === 'playing') {
      desiredPlaybackRef.current = 'paused';
      dependencies.synthesis.pause();
      setState((current) => ({ ...current, status: 'paused' }));
      return;
    }
    if (state.status === 'paused') {
      desiredPlaybackRef.current = 'playing';
      dependencies.synthesis.resume();
      setState((current) => ({ ...current, status: 'playing' }));
      return;
    }
    speakIndexRef.current(queue.index);
  }, [state.status]);

  const previous = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || queue.index <= 0) return;
    speakIndexRef.current(queue.index - 1);
  }, []);

  const next = useCallback(() => {
    const queue = queueRef.current;
    if (!queue || queue.index + 1 >= queue.items.length) return;
    speakIndexRef.current(queue.index + 1);
  }, []);

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
    return () => {
      generationRef.current += 1;
      getBrowserSpeechSynthesisDependencies()?.synthesis.cancel();
      queueRef.current = null;
      clearOverlay();
    };
  }, [bookId, clearOverlay]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  return {
    state,
    feedback,
    supported,
    voices,
    speakSelection,
    speakFromCurrentPosition,
    togglePause,
    previous,
    next,
    stop,
  };
};
