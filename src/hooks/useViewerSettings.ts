import { useCallback, useState } from 'react';
import type { ViewerSettings } from '../types.ts';
import {
  normalizeReaderDictionaryProvider,
  normalizeReaderLanguage,
  normalizeReaderTranslationProvider,
  normalizeReaderTranslationSourceLanguage,
} from '../lib/readerLanguageTools.ts';
import {
  normalizeReaderTtsChapterEndAction,
  normalizeReaderTtsLanguage,
  normalizeReaderTtsRate,
  normalizeReaderTtsVoiceUri,
} from '../lib/readerTts.ts';

const SETTINGS_KEY = 'viewer_settings';
const TTS_CONTINUOUS_DEFAULTS_KEY = 'viewer_settings_tts_continuous_defaults_v1';

export const defaultSettings: ViewerSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 1,
  padding: 24,
  textAlign: 'justify',
  theme: 'dark',
  navMode: 'scroll',
  tapTopBottomPercent: 33,
  tapLeftRightPercent: 30,
  landscapeTwoPage: false,
  autoOpenLastBook: true,
  fontFamily: 'ridi',
  accentColor: 'yellow',
  translationProvider: 'auto',
  translationSourceLanguage: 'auto',
  translationTargetLanguage: 'ko',
  dictionaryProvider: 'naver',
  ttsLanguage: 'auto',
  ttsVoiceURI: '',
  ttsRate: 1,
  ttsChapterEndAction: 'next',
  customThemes: [],
};

export const getStoredViewerSettings = () => {
  if (typeof window === 'undefined') return defaultSettings;

  const savedSettings = localStorage.getItem(SETTINGS_KEY);
  if (!savedSettings) {
    localStorage.setItem(TTS_CONTINUOUS_DEFAULTS_KEY, '1');
    return defaultSettings;
  }

  try {
    const parsed: unknown = JSON.parse(savedSettings);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultSettings;
    const shouldAdoptContinuousDefaults = localStorage.getItem(TTS_CONTINUOUS_DEFAULTS_KEY) !== '1';
    const merged = {
      ...defaultSettings,
      ...parsed,
      ...(shouldAdoptContinuousDefaults ? { ttsChapterEndAction: 'next' as const } : {}),
    } as ViewerSettings;
    if (shouldAdoptContinuousDefaults) {
      localStorage.setItem(TTS_CONTINUOUS_DEFAULTS_KEY, '1');
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    }
    return {
      ...merged,
      landscapeTwoPage: merged.landscapeTwoPage === true,
      translationProvider: normalizeReaderTranslationProvider(merged.translationProvider),
      translationSourceLanguage: normalizeReaderTranslationSourceLanguage(
        merged.translationSourceLanguage,
      ),
      translationTargetLanguage: normalizeReaderLanguage(
        merged.translationTargetLanguage,
        'ko',
      ),
      dictionaryProvider: normalizeReaderDictionaryProvider(merged.dictionaryProvider),
      ttsLanguage: normalizeReaderTtsLanguage(merged.ttsLanguage),
      ttsVoiceURI: normalizeReaderTtsVoiceUri(merged.ttsVoiceURI),
      ttsRate: normalizeReaderTtsRate(merged.ttsRate),
      ttsChapterEndAction: normalizeReaderTtsChapterEndAction(merged.ttsChapterEndAction),
    };
  } catch {
    return defaultSettings;
  }
};

export const useViewerSettings = () => {
  const [settings, setSettings] = useState<ViewerSettings>(getStoredViewerSettings);

  const updateSettings = useCallback((newSettings: Partial<ViewerSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  return {
    settings,
    updateSettings,
  };
};
