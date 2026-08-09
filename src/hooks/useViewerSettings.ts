import { useCallback, useState } from 'react';
import type { ViewerSettings } from '../types.ts';
import {
  normalizeReaderDictionaryProvider,
  normalizeReaderLanguage,
  normalizeReaderTranslationProvider,
  normalizeReaderTranslationSourceLanguage,
} from '../lib/readerLanguageTools.ts';

const SETTINGS_KEY = 'viewer_settings';

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
  autoOpenLastBook: true,
  fontFamily: 'ridi',
  accentColor: 'sky',
  translationProvider: 'auto',
  translationSourceLanguage: 'auto',
  translationTargetLanguage: 'ko',
  dictionaryProvider: 'naver',
  customThemes: [],
};

export const getStoredViewerSettings = () => {
  if (typeof window === 'undefined') return defaultSettings;

  const savedSettings = localStorage.getItem(SETTINGS_KEY);
  if (!savedSettings) return defaultSettings;

  try {
    const parsed: unknown = JSON.parse(savedSettings);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultSettings;
    const merged = { ...defaultSettings, ...parsed } as ViewerSettings;
    return {
      ...merged,
      translationProvider: normalizeReaderTranslationProvider(merged.translationProvider),
      translationSourceLanguage: normalizeReaderTranslationSourceLanguage(
        merged.translationSourceLanguage,
      ),
      translationTargetLanguage: normalizeReaderLanguage(
        merged.translationTargetLanguage,
        'ko',
      ),
      dictionaryProvider: normalizeReaderDictionaryProvider(merged.dictionaryProvider),
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
