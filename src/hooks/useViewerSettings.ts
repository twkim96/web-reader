import { useCallback, useEffect, useState } from 'react';
import { ViewerSettings } from '../types';

const SETTINGS_KEY = 'viewer_settings';

const defaultSettings: ViewerSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  padding: 24,
  textAlign: 'justify',
  theme: 'sepia',
  navMode: 'scroll',
  fontFamily: 'ridi',
  accentColor: 'sky',
};

const getStoredViewerSettings = () => {
  const savedSettings = localStorage.getItem(SETTINGS_KEY);
  if (!savedSettings) return defaultSettings;

  try {
    return { ...defaultSettings, ...JSON.parse(savedSettings) };
  } catch {
    return defaultSettings;
  }
};

export const useViewerSettings = () => {
  const [settings, setSettings] = useState<ViewerSettings>(defaultSettings);

  useEffect(() => {
    queueMicrotask(() => {
      setSettings(getStoredViewerSettings());
    });
  }, []);

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
