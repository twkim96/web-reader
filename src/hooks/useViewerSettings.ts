// src/hooks/useViewerSettings.ts
'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ViewerSettings } from '../types';
import { THEMES, ACCENT_PALETTE } from '../lib/constants';

const DEFAULT_SETTINGS: ViewerSettings = {
  fontSize: 18,
  lineHeight: 1.9,
  padding: 24,
  textAlign: 'justify',
  theme: 'sepia',
  navMode: 'scroll',
  fontFamily: 'sans',
  encoding: 'auto',
  accentColor: 'sky',
};

export function useViewerSettings() {
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const savedSettings = localStorage.getItem('viewer_settings');
    if (savedSettings) {
      try {
        setSettings(prev => ({ ...prev, ...JSON.parse(savedSettings) }));
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
  }, []);

  const handleUpdateSettings = useCallback((newSettings: Partial<ViewerSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      localStorage.setItem('viewer_settings', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;
  const accentColorObj = ACCENT_PALETTE[settings.accentColor] || ACCENT_PALETTE.indigo;

  const dynamicStyles = useMemo(() => ({
    '--accent-400': accentColorObj[400],
    '--accent-500': accentColorObj[500],
    '--accent-600': accentColorObj[600],
  } as React.CSSProperties), [accentColorObj]);

  return { settings, handleUpdateSettings, theme, accentColorObj, dynamicStyles };
}
