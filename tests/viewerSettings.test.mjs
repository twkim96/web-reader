import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultSettings,
  getStoredViewerSettings,
} from '../src/hooks/useViewerSettings.ts';
import { getMuzioShelfDockVariables } from '../src/lib/shelfDockTheme.ts';

const SETTINGS_KEY = 'viewer_settings';
const TTS_CONTINUOUS_DEFAULTS_KEY = 'viewer_settings_tts_continuous_defaults_v1';

const withStorage = async (initialValue, callback, continuousDefaultsApplied = false) => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const data = new Map();
  if (initialValue !== undefined) {
    data.set(SETTINGS_KEY, initialValue);
  }
  if (continuousDefaultsApplied) data.set(TTS_CONTINUOUS_DEFAULTS_KEY, '1');

  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };

  try {
    await callback();
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousLocalStorage;
  }
};

test('defaults auto-open for older stored viewer settings', async () => {
  await withStorage(JSON.stringify({ fontSize: 21 }), () => {
    const settings = getStoredViewerSettings();

    assert.equal(settings.fontSize, 21);
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.accentColor, 'yellow');
    assert.equal(settings.autoOpenLastBook, true);
    assert.equal(settings.landscapeTwoPage, false);
    assert.equal(settings.translationProvider, 'auto');
    assert.equal(settings.translationSourceLanguage, 'auto');
    assert.equal(settings.translationTargetLanguage, 'ko');
    assert.equal(settings.dictionaryProvider, 'naver');
    assert.equal(settings.ttsLanguage, 'auto');
    assert.equal(settings.ttsVoiceURI, '');
    assert.equal(settings.ttsRate, 1);
    assert.equal(settings.ttsChapterEndAction, 'next');
  });
});

test('normalizes unsupported language-tool settings from older or edited storage', async () => {
  await withStorage(JSON.stringify({
    translationProvider: 'unknown',
    translationSourceLanguage: 'fr',
    translationTargetLanguage: 'de',
    dictionaryProvider: 'unknown',
    ttsLanguage: 'fr-FR',
    ttsVoiceURI: 123,
    ttsRate: 9,
    ttsChapterEndAction: 'repeat',
  }), () => {
    const settings = getStoredViewerSettings();
    assert.equal(settings.translationProvider, 'auto');
    assert.equal(settings.translationSourceLanguage, 'auto');
    assert.equal(settings.translationTargetLanguage, 'ko');
    assert.equal(settings.dictionaryProvider, 'naver');
    assert.equal(settings.ttsLanguage, 'auto');
    assert.equal(settings.ttsVoiceURI, '');
    assert.equal(settings.ttsRate, 2);
    assert.equal(settings.ttsChapterEndAction, 'next');
  });
});

test('preserves a stop action selected after the continuous-listening migration', async () => {
  await withStorage(JSON.stringify({ ttsChapterEndAction: 'stop' }), () => {
    assert.equal(getStoredViewerSettings().ttsChapterEndAction, 'stop');
  }, true);
});

test('preserves an explicit auto-open setting', async () => {
  await withStorage(JSON.stringify({ autoOpenLastBook: false }), () => {
    const settings = getStoredViewerSettings();

    assert.equal(settings.autoOpenLastBook, false);
    assert.equal(defaultSettings.autoOpenLastBook, true);
  });
});

test('preserves only an explicit boolean landscape two-page setting', async () => {
  await withStorage(JSON.stringify({ landscapeTwoPage: true }), () => {
    assert.equal(getStoredViewerSettings().landscapeTwoPage, true);
  });
  await withStorage(JSON.stringify({ landscapeTwoPage: 'true' }), () => {
    assert.equal(getStoredViewerSettings().landscapeTwoPage, false);
  });
});

test('uses Muzio mini-player surfaces for light and dark shelf docks', () => {
  const dark = getMuzioShelfDockVariables('#272728');
  const light = getMuzioShelfDockVariables('#ffffff');

  assert.equal(dark['--viewer-shelf-dock-surface'], 'rgba(39, 39, 40, 0.88)');
  assert.equal(dark['--viewer-shelf-dock-border'], 'rgba(255, 255, 255, 0.045)');
  assert.equal(dark['--viewer-shelf-dock-shadow'], 'rgba(0, 0, 0, 0.35)');
  assert.equal(light['--viewer-shelf-dock-surface'], 'rgba(255, 255, 255, 0.88)');
  assert.equal(light['--viewer-shelf-dock-border'], 'rgba(228, 228, 231, 0.35)');
  assert.equal(light['--viewer-shelf-dock-shadow'], 'rgba(0, 0, 0, 0.10)');
});
