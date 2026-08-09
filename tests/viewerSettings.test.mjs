import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultSettings,
  getStoredViewerSettings,
} from '../src/hooks/useViewerSettings.ts';

const SETTINGS_KEY = 'viewer_settings';

const withStorage = async (initialValue, callback) => {
  const previousWindow = globalThis.window;
  const previousLocalStorage = globalThis.localStorage;
  const data = new Map();
  if (initialValue !== undefined) {
    data.set(SETTINGS_KEY, initialValue);
  }

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
    assert.equal(settings.autoOpenLastBook, true);
    assert.equal(settings.translationProvider, 'auto');
    assert.equal(settings.translationSourceLanguage, 'auto');
    assert.equal(settings.translationTargetLanguage, 'ko');
    assert.equal(settings.dictionaryProvider, 'naver');
  });
});

test('normalizes unsupported language-tool settings from older or edited storage', async () => {
  await withStorage(JSON.stringify({
    translationProvider: 'unknown',
    translationSourceLanguage: 'fr',
    translationTargetLanguage: 'de',
    dictionaryProvider: 'unknown',
  }), () => {
    const settings = getStoredViewerSettings();
    assert.equal(settings.translationProvider, 'auto');
    assert.equal(settings.translationSourceLanguage, 'auto');
    assert.equal(settings.translationTargetLanguage, 'ko');
    assert.equal(settings.dictionaryProvider, 'naver');
  });
});

test('preserves an explicit auto-open setting', async () => {
  await withStorage(JSON.stringify({ autoOpenLastBook: false }), () => {
    const settings = getStoredViewerSettings();

    assert.equal(settings.autoOpenLastBook, false);
    assert.equal(defaultSettings.autoOpenLastBook, true);
  });
});
