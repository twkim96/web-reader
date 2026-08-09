import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READER_DICTIONARY_TEXT_MAX_LENGTH,
  READER_TRANSLATION_TEXT_MAX_LENGTH,
  buildReaderDictionaryUrl,
  buildReaderTranslationUrl,
  buildTranslationAnnotationNote,
  getReaderTranslationRoute,
  getTranslationAnnotationSaveUnavailableReason,
  hasSameReaderTranslationLanguage,
  inferReaderLanguage,
  normalizeReaderDictionaryProvider,
  normalizeReaderLanguage,
  normalizeReaderTranslationProvider,
  normalizeReaderTranslationSourceLanguage,
  openReaderLanguageToolUrl,
  resolveReaderSourceLanguage,
  validateReaderLanguageToolText,
} from '../src/lib/readerLanguageTools.ts';
import {
  BrowserTranslationUnavailableError,
  isBrowserTranslatorExposed,
  translateWithBrowser,
} from '../src/lib/browserTranslator.ts';

test('infers supported reader languages without guessing ambiguous ideographs', () => {
  assert.equal(inferReaderLanguage('한국어 문장'), 'ko');
  assert.equal(inferReaderLanguage('日本語です'), 'ja');
  assert.equal(inferReaderLanguage('English sentence'), 'en');
  assert.equal(inferReaderLanguage('漢字'), null);
  assert.equal(resolveReaderSourceLanguage('ja', '漢字'), 'ja');
});

test('normalizes stored language-tool settings to supported values', () => {
  assert.equal(normalizeReaderTranslationProvider('papago'), 'papago');
  assert.equal(normalizeReaderTranslationProvider('unknown'), 'auto');
  assert.equal(normalizeReaderTranslationSourceLanguage('ja'), 'ja');
  assert.equal(normalizeReaderTranslationSourceLanguage('fr'), 'auto');
  assert.equal(normalizeReaderLanguage('en', 'ko'), 'en');
  assert.equal(normalizeReaderLanguage('fr', 'ko'), 'ko');
  assert.equal(normalizeReaderDictionaryProvider('wiktionary'), 'wiktionary');
  assert.equal(normalizeReaderDictionaryProvider('unknown'), 'naver');
});

test('uses browser translation only when auto mode can actually start it', () => {
  assert.equal(getReaderTranslationRoute({
    provider: 'auto',
    browserTranslatorExposed: true,
    sourceLanguage: 'en',
  }), 'browser');
  assert.equal(getReaderTranslationRoute({
    provider: 'auto',
    browserTranslatorExposed: false,
    sourceLanguage: 'en',
  }), 'google');
  assert.equal(getReaderTranslationRoute({
    provider: 'auto',
    browserTranslatorExposed: true,
    sourceLanguage: null,
  }), 'google');
  assert.equal(getReaderTranslationRoute({
    provider: 'browser',
    browserTranslatorExposed: false,
    sourceLanguage: 'en',
  }), 'browser');
  assert.equal(getReaderTranslationRoute({
    provider: 'papago',
    browserTranslatorExposed: true,
    sourceLanguage: 'en',
  }), 'papago');
});

test('blocks known same-language translation before selecting any provider', () => {
  assert.equal(hasSameReaderTranslationLanguage('ko', 'ko'), true);
  assert.equal(hasSameReaderTranslationLanguage('en', 'ko'), false);
  assert.equal(hasSameReaderTranslationLanguage(null, 'ko'), false);
});

test('enforces translation and dictionary selection limits after trimming', () => {
  assert.deepEqual(validateReaderLanguageToolText('  hello  ', 'translation'), {
    ok: true,
    text: 'hello',
  });
  assert.deepEqual(validateReaderLanguageToolText('   ', 'dictionary'), {
    ok: false,
    reason: 'empty',
  });
  assert.equal(validateReaderLanguageToolText(
    'x'.repeat(READER_TRANSLATION_TEXT_MAX_LENGTH + 1),
    'translation',
  ).reason, 'too-long');
  assert.equal(validateReaderLanguageToolText(
    'x'.repeat(READER_DICTIONARY_TEXT_MAX_LENGTH + 1),
    'dictionary',
  ).reason, 'too-long');
});

test('builds encoded external translation and language-specific dictionary URLs', () => {
  const google = new URL(buildReaderTranslationUrl({
    provider: 'google',
    text: 'hello & 안녕',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }));
  assert.equal(google.origin, 'https://translate.google.com');
  assert.equal(google.searchParams.get('sl'), 'en');
  assert.equal(google.searchParams.get('tl'), 'ko');
  assert.equal(google.searchParams.get('text'), 'hello & 안녕');

  const papago = new URL(buildReaderTranslationUrl({
    provider: 'papago',
    text: 'hello',
    sourceLanguage: null,
    targetLanguage: 'ja',
  }));
  assert.equal(papago.origin, 'https://papago.naver.com');
  assert.equal(papago.searchParams.get('sk'), 'auto');
  assert.equal(papago.searchParams.get('tk'), 'ja');

  const naver = new URL(buildReaderDictionaryUrl({
    provider: 'naver',
    text: '辞書',
    sourceLanguage: 'ja',
  }));
  assert.equal(naver.origin, 'https://ja.dict.naver.com');
  assert.equal(naver.hash, '#/search?query=%E8%BE%9E%E6%9B%B8');

  const integratedNaver = new URL(buildReaderDictionaryUrl({
    provider: 'naver',
    text: '漢字',
    sourceLanguage: null,
  }));
  assert.equal(integratedNaver.origin, 'https://dict.naver.com');
  assert.equal(integratedNaver.searchParams.get('dicQuery'), '漢字');

  const wiktionary = new URL(buildReaderDictionaryUrl({
    provider: 'wiktionary',
    text: 'reader',
    sourceLanguage: 'en',
  }));
  assert.equal(wiktionary.origin, 'https://en.wiktionary.org');
  assert.equal(wiktionary.searchParams.get('search'), 'reader');
});

test('detects blocked external windows and severs a successful opener', () => {
  assert.equal(openReaderLanguageToolUrl('https://example.com', () => null), false);
  const handle = { opener: {}, closed: false, close() { this.closed = true; } };
  assert.equal(openReaderLanguageToolUrl('https://example.com', () => handle), true);
  assert.equal(handle.opener, null);
  assert.equal(handle.closed, false);
});

test('appends a bounded translation block without overwriting an existing note', () => {
  const appended = buildTranslationAnnotationNote({
    existingNote: '기존 메모',
    translatedText: '번역 결과',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  });
  assert.equal(appended, '기존 메모\n\n[번역 en→ko]\n번역 결과');
  assert.equal(buildTranslationAnnotationNote({
    existingNote: appended,
    translatedText: '번역 결과',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }), appended);
  assert.equal(buildTranslationAnnotationNote({
    existingNote: 'x'.repeat(3_990),
    translatedText: '번역 결과',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }), null);
});

test('keeps long translation available while explaining annotation save limits', () => {
  assert.match(getTranslationAnnotationSaveUnavailableReason({
    selectionText: 'x'.repeat(4_001),
    translatedText: '번역 결과',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }), /4,000자/);
  assert.match(getTranslationAnnotationSaveUnavailableReason({
    selectionText: 'short',
    translatedText: 'x'.repeat(4_000),
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }), /메모 최대 길이/);
  assert.equal(getTranslationAnnotationSaveUnavailableReason({
    selectionText: 'short',
    translatedText: '번역 결과',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
  }), null);
});

test('uses an available browser translator and always releases it', async (t) => {
  const original = globalThis.Translator;
  t.after(() => { globalThis.Translator = original; });
  let destroyed = 0;
  let translatedSignal;
  globalThis.Translator = {
    availability: async () => 'available',
    create: async () => ({
      translate: async (text, options) => {
        translatedSignal = options.signal;
        return `번역:${text}`;
      },
      destroy: () => { destroyed += 1; },
    }),
  };
  const controller = new AbortController();
  assert.equal(isBrowserTranslatorExposed(), true);
  assert.equal(await translateWithBrowser({
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    signal: controller.signal,
  }), '번역:hello');
  assert.equal(translatedSignal, controller.signal);
  assert.equal(destroyed, 1);
});

test('reports browser model download progress and unavailable language pairs', async (t) => {
  const original = globalThis.Translator;
  t.after(() => { globalThis.Translator = original; });
  const progress = [];
  globalThis.Translator = {
    availability: async () => 'downloadable',
    create: async (options) => {
      options.monitor?.({
        addEventListener: (_type, listener) => listener({ loaded: 0.65 }),
      });
      return {
        translate: async () => '결과',
        destroy: () => undefined,
      };
    },
  };
  assert.equal(await translateWithBrowser({
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    signal: new AbortController().signal,
    onDownloadProgress: (value) => progress.push(value),
  }), '결과');
  assert.deepEqual(progress, [0.65]);

  globalThis.Translator = { availability: async () => 'unavailable' };
  await assert.rejects(translateWithBrowser({
    text: 'hello',
    sourceLanguage: 'en',
    targetLanguage: 'ko',
    signal: new AbortController().signal,
  }), BrowserTranslationUnavailableError);
});
