import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  defaultSettings,
  getStoredViewerSettings,
} from '../src/hooks/useViewerSettings.ts';
import { getMuzioShelfDockVariables } from '../src/lib/shelfDockTheme.ts';
import { THEMES } from '../src/lib/constants.ts';
import {
  getGoogleSignInButtonVariant,
  getThemeAccentColor,
  getThemeColors,
  getThemeCssVariables,
} from '../src/lib/themeUtils.ts';

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

test('uses 20px only as the default font size and preserves an explicit saved size', async () => {
  await withStorage(undefined, () => {
    assert.equal(getStoredViewerSettings().fontSize, 20);
    assert.equal(defaultSettings.fontSize, 20);
  });
  await withStorage(JSON.stringify({ fontSize: 18 }), () => {
    assert.equal(getStoredViewerSettings().fontSize, 18);
  });
});

test('uses Midnight as the new default while preserving an explicit saved theme', async () => {
  await withStorage(undefined, () => {
    assert.equal(getStoredViewerSettings().theme, 'midnight');
    assert.equal(defaultSettings.theme, 'midnight');
  });
  await withStorage(JSON.stringify({ theme: 'dark' }), () => {
    assert.equal(getStoredViewerSettings().theme, 'dark');
  });

  const layout = await readFile(new URL('../src/app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /let settings = \{ theme: 'midnight'/);
  assert.match(layout, /builtInThemes\[settings\.theme\] \|\| builtInThemes\.midnight/);
});

test('selects the official Google button contrast from the active theme background', () => {
  assert.equal(getGoogleSignInButtonVariant('#ffffff'), 'light');
  assert.equal(getGoogleSignInButtonVariant('#f4ecd8'), 'light');
  assert.equal(getGoogleSignInButtonVariant('#272728'), 'dark');
  assert.equal(getGoogleSignInButtonVariant('#141517'), 'dark');
  assert.equal(getGoogleSignInButtonVariant('invalid'), 'dark');
});

test('derives dedicated low-blur glass contrast tokens from theme luminance', () => {
  const light = getThemeCssVariables({ theme: 'light', customThemes: [] });
  const midnight = getThemeCssVariables({ theme: 'midnight', customThemes: [] });

  assert.equal(light['--viewer-shelf-glass-surface'], 'rgba(255, 255, 255, 0.24)');
  assert.equal(light['--viewer-shelf-glass-ink'], 'rgba(20, 21, 23, 0.88)');
  assert.equal(light['--viewer-shelf-glass-ink-edge'], 'rgba(255, 255, 255, 0.58)');
  assert.equal(midnight['--viewer-shelf-glass-surface'], 'rgba(20, 21, 23, 0.24)');
  assert.equal(midnight['--viewer-shelf-glass-ink'], 'rgba(245, 246, 248, 0.90)');
  assert.equal(midnight['--viewer-shelf-glass-ink-edge'], 'rgba(0, 0, 0, 0.58)');
});

test('pins built-in accents and stores accent choices only on custom themes', () => {
  const legacyAccent = { accentColor: 'indigo', customThemes: [] };
  assert.equal(getThemeAccentColor({ ...legacyAccent, theme: 'light' }), 'rose');
  assert.equal(getThemeAccentColor({ ...legacyAccent, theme: 'sepia' }), 'emerald');
  assert.equal(getThemeAccentColor({ ...legacyAccent, theme: 'dark' }), 'yellow');
  assert.equal(getThemeAccentColor({ ...legacyAccent, theme: 'midnight' }), 'rose');

  const customThemes = [{
    id: 'custom:accent',
    title: 'Accent',
    bgColor: '#202124',
    textColor: '#f2f2f2',
    texture: 'none',
    accentColor: 'sky',
  }];
  assert.equal(getThemeAccentColor({ theme: 'custom:accent', accentColor: 'amber', customThemes }), 'sky');
  assert.equal(getThemeAccentColor({
    theme: 'custom:legacy',
    accentColor: 'amber',
    customThemes: [{ ...customThemes[0], id: 'custom:legacy', accentColor: undefined }],
  }), 'amber');
});

test('keeps both embedded Google button PNGs byte-identical to the official assets', async () => {
  const source = await readFile(new URL('../src/components/GoogleSignInButtonAsset.tsx', import.meta.url), 'utf8');
  const expectedHashes = {
    DARK: '64cbfc1f786effc40f449e4b3c1fcd104825bfc087704e453cd8c9d70396f957',
    LIGHT: '42a5750ee95926ca5410404ee5a34f8b6d58d290317200bf7e33e126873f4b83',
  };

  for (const [variant, expectedHash] of Object.entries(expectedHashes)) {
    const encoded = source.match(
      new RegExp(`GOOGLE_SIGN_IN_${variant}_BUTTON = 'data:image\\/png;base64,([^']+)'`),
    )?.[1];
    assert.ok(encoded, `${variant} Google button data was not found`);
    assert.equal(createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex'), expectedHash);
  }
});

test('defaults auto-open for older stored viewer settings', async () => {
  await withStorage(JSON.stringify({ fontSize: 21 }), () => {
    const settings = getStoredViewerSettings();

    assert.equal(settings.fontSize, 21);
    assert.equal(settings.theme, 'midnight');
    assert.equal(settings.accentColor, 'rose');
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
    assert.equal(settings.shelfDockStyle, 'standard');
  });
});

test('preserves only a supported shelf dock style', async () => {
  await withStorage(JSON.stringify({ shelfDockStyle: 'glass' }), () => {
    assert.equal(getStoredViewerSettings().shelfDockStyle, 'glass');
  });
  await withStorage(JSON.stringify({ shelfDockStyle: 'standard' }), () => {
    assert.equal(getStoredViewerSettings().shelfDockStyle, 'standard');
  });
  await withStorage(JSON.stringify({ shelfDockStyle: 'modern' }), () => {
    assert.equal(getStoredViewerSettings().shelfDockStyle, 'modern');
  });
  await withStorage(JSON.stringify({ shelfDockStyle: 'legacy' }), () => {
    assert.equal(getStoredViewerSettings().shelfDockStyle, 'standard');
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

test('replaces the built-in Blue theme with exact Midnight colors and theme action surfaces', () => {
  assert.equal('blue' in THEMES, false);
  assert.deepEqual(THEMES.midnight, {
    bg: 'bg-[#141517]',
    text: 'text-[#d2d3d6]',
    border: 'border-white/10',
    secondary: 'bg-white/5',
  });

  const colors = getThemeColors({ theme: 'midnight', customThemes: [] });
  const variables = getThemeCssVariables({ theme: 'midnight', customThemes: [] });
  assert.deepEqual(colors, { bg: '#141517', text: '#d2d3d6', texture: 'none' });
  assert.equal(variables['--viewer-theme-action-soft'], '#353637');
  assert.equal(variables['--viewer-theme-action-strong'], '#101113');
});
