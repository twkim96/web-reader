'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ReaderLanguage,
  ViewerSettings,
} from '../../types';
import type { ReaderTextSelection } from './useReaderTextSelection';
import {
  buildReaderDictionaryUrl,
  buildReaderTranslationUrl,
  getReaderTranslationRoute,
  hasSameReaderTranslationLanguage,
  openReaderLanguageToolUrl,
  resolveReaderSourceLanguage,
  validateReaderLanguageToolText,
} from '../../lib/readerLanguageTools';
import {
  BrowserTranslationUnavailableError,
  isBrowserTranslatorExposed,
  translateWithBrowser,
  type BrowserTranslationAvailability,
} from '../../lib/browserTranslator';
import { writeTextToClipboard } from '../../lib/clipboard';

export type ReaderTranslationPanelState = {
  selection: ReaderTextSelection;
  sourceLanguage: ReaderLanguage | null;
  targetLanguage: ReaderLanguage;
  status: 'loading' | 'downloading' | 'success' | 'error';
  availability?: BrowserTranslationAvailability;
  downloadProgress?: number;
  translatedText?: string;
  error?: string;
};

const getTranslationErrorMessage = (error: unknown) => {
  if (error instanceof BrowserTranslationUnavailableError) return error.message;
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return '내장 번역 실행 권한이 없거나 사용자 동작이 만료됐습니다.';
    }
    if (error.name === 'NetworkError') {
      return '번역 언어 모델을 내려받지 못했습니다. 네트워크 상태를 확인해 주세요.';
    }
    if (error.name === 'NotSupportedError') {
      return '선택한 원문·대상 언어 조합을 내장 번역이 지원하지 않습니다.';
    }
  }
  return '브라우저 내장 번역을 완료하지 못했습니다.';
};

export const useReaderLanguageTools = ({
  settings,
  dismissSelectionMenu,
  clearSelection,
  showFeedback,
}: {
  settings: ViewerSettings;
  dismissSelectionMenu: () => void;
  clearSelection: () => void;
  showFeedback: (message: string) => void;
}) => {
  const [translation, setTranslation] = useState<ReaderTranslationPanelState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const abortTranslation = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const closeTranslation = useCallback(() => {
    abortTranslation();
    setTranslation(null);
    clearSelection();
  }, [abortTranslation, clearSelection]);

  const openExternal = useCallback((url: string) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      showFeedback('오프라인에서는 외부 번역·사전을 열 수 없어요');
      return false;
    }
    if (!openReaderLanguageToolUrl(url)) {
      showFeedback('새 탭이 차단됐어요. 팝업 허용 후 다시 시도해 주세요');
      return false;
    }
    return true;
  }, [showFeedback]);

  const openExternalTranslation = useCallback((
    selection: ReaderTextSelection,
    provider: 'google' | 'papago',
  ) => {
    const validation = validateReaderLanguageToolText(selection.text, 'translation');
    if (!validation.ok) {
      showFeedback(validation.reason === 'too-long'
        ? '번역은 5,000자까지 선택할 수 있어요'
        : '번역할 텍스트를 선택해 주세요');
      return false;
    }
    const sourceLanguage = resolveReaderSourceLanguage(
      settings.translationSourceLanguage,
      validation.text,
    );
    if (hasSameReaderTranslationLanguage(
      sourceLanguage,
      settings.translationTargetLanguage,
    )) {
      showFeedback('원문과 번역 대상 언어가 같습니다. 대상 언어를 바꿔 주세요');
      return false;
    }
    const url = buildReaderTranslationUrl({
      provider,
      text: validation.text,
      sourceLanguage,
      targetLanguage: settings.translationTargetLanguage,
    });
    const opened = openExternal(url);
    if (opened) {
      clearSelection();
      setTranslation(null);
      showFeedback(
        provider === 'papago' ? 'Papago를 열었습니다' : 'Google Translate를 열었습니다',
      );
    }
    return opened;
  }, [clearSelection, openExternal, settings, showFeedback]);

  const translateSelection = useCallback((selection: ReaderTextSelection) => {
    const validation = validateReaderLanguageToolText(selection.text, 'translation');
    if (!validation.ok) {
      showFeedback(validation.reason === 'too-long'
        ? '번역은 5,000자까지 선택할 수 있어요'
        : '번역할 텍스트를 선택해 주세요');
      return;
    }
    const sourceLanguage = resolveReaderSourceLanguage(
      settings.translationSourceLanguage,
      validation.text,
    );
    const targetLanguage = settings.translationTargetLanguage;
    if (hasSameReaderTranslationLanguage(sourceLanguage, targetLanguage)) {
      abortTranslation();
      dismissSelectionMenu();
      setTranslation({
        selection,
        sourceLanguage,
        targetLanguage,
        status: 'error',
        error: '원문과 번역 대상 언어가 같습니다. 리더 설정에서 대상 언어를 바꿔 주세요.',
      });
      return;
    }
    const route = getReaderTranslationRoute({
      provider: settings.translationProvider,
      browserTranslatorExposed: isBrowserTranslatorExposed(),
      sourceLanguage,
    });
    if (route === 'google' || route === 'papago') {
      openExternalTranslation(selection, route);
      return;
    }

    abortTranslation();
    dismissSelectionMenu();
    const generation = generationRef.current;
    if (!sourceLanguage) {
      setTranslation({
        selection,
        sourceLanguage: null,
        targetLanguage,
        status: 'error',
        error: '원문 언어를 자동으로 판단하지 못했습니다. 리더 설정에서 원문 언어를 선택해 주세요.',
      });
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setTranslation({
      selection,
      sourceLanguage,
      targetLanguage,
      status: 'loading',
    });
    void translateWithBrowser({
      text: validation.text,
      sourceLanguage,
      targetLanguage,
      signal: controller.signal,
      onAvailability: (availability) => {
        if (generationRef.current !== generation) return;
        setTranslation((current) => current ? {
          ...current,
          availability,
          status: availability === 'available' ? 'loading' : 'downloading',
        } : current);
      },
      onDownloadProgress: (downloadProgress) => {
        if (generationRef.current !== generation) return;
        setTranslation((current) => current ? {
          ...current,
          status: 'downloading',
          downloadProgress,
        } : current);
      },
    }).then((translatedText) => {
      if (generationRef.current !== generation || controller.signal.aborted) return;
      setTranslation((current) => current ? {
        ...current,
        status: 'success',
        translatedText,
        error: undefined,
      } : current);
    }).catch((error) => {
      if (controller.signal.aborted || generationRef.current !== generation) return;
      setTranslation((current) => current ? {
        ...current,
        status: 'error',
        error: getTranslationErrorMessage(error),
      } : current);
    }).finally(() => {
      if (abortRef.current === controller) abortRef.current = null;
    });
  }, [abortTranslation, dismissSelectionMenu, openExternalTranslation, settings, showFeedback]);

  const lookupSelection = useCallback((selection: ReaderTextSelection) => {
    const validation = validateReaderLanguageToolText(selection.text, 'dictionary');
    if (!validation.ok) {
      showFeedback(validation.reason === 'too-long'
        ? '사전 검색은 200자까지 선택할 수 있어요'
        : '사전에서 찾을 텍스트를 선택해 주세요');
      return;
    }
    const sourceLanguage = resolveReaderSourceLanguage(
      settings.translationSourceLanguage,
      validation.text,
    );
    const url = buildReaderDictionaryUrl({
      provider: settings.dictionaryProvider,
      text: validation.text,
      sourceLanguage,
    });
    if (openExternal(url)) {
      clearSelection();
      showFeedback('사전을 열었습니다');
    }
  }, [clearSelection, openExternal, settings, showFeedback]);

  const openTranslationFallback = useCallback((provider: 'google' | 'papago') => {
    if (!translation) return false;
    const opened = openExternalTranslation(translation.selection, provider);
    if (opened) abortTranslation();
    return opened;
  }, [abortTranslation, openExternalTranslation, translation]);

  const copyTranslation = useCallback(async () => {
    if (!translation?.translatedText) return false;
    try {
      await writeTextToClipboard(translation.translatedText);
      showFeedback('번역 결과 복사됨');
      return true;
    } catch (error) {
      console.warn('[ReaderLanguageTools] translation copy failed:', error);
      showFeedback('번역 결과 복사 실패');
      return false;
    }
  }, [showFeedback, translation]);

  useEffect(() => () => abortTranslation(), [abortTranslation]);

  return {
    translation,
    translateSelection,
    lookupSelection,
    closeTranslation,
    openTranslationFallback,
    copyTranslation,
  };
};
