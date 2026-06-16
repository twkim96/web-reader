import { useCallback, useState } from 'react';
import type { ViewerSettings } from '../types';

const SETTINGS_KEY = 'viewer_settings';

export const defaultSettings: ViewerSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 1,
  padding: 24,
  textAlign: 'justify',
  theme: 'sepia',
  navMode: 'scroll',
  tapTopBottomPercent: 33,
  tapLeftRightPercent: 30,
  autoOpenLastBook: true,
  fontFamily: 'ridi',
  accentColor: 'sky',
  customThemes: [],
};

export const getStoredViewerSettings = () => {
  if (typeof window === 'undefined') return defaultSettings;

  const savedSettings = localStorage.getItem(SETTINGS_KEY);
  if (!savedSettings) return defaultSettings;

  try {
    return { ...defaultSettings, ...JSON.parse(savedSettings) };
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
