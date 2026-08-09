import type {
  ReaderDictionaryProvider,
  ReaderLanguage,
  ReaderTranslationProvider,
  ReaderTranslationSourceLanguage,
} from '../types.ts';
import {
  ANNOTATION_NOTE_MAX_LENGTH,
  ANNOTATION_QUOTE_MAX_LENGTH,
} from './annotationPolicy.ts';

export const READER_TRANSLATION_TEXT_MAX_LENGTH = 5_000;
export const READER_DICTIONARY_TEXT_MAX_LENGTH = 200;

export const READER_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: ReaderLanguage;
  label: string;
}> = [
  { value: 'ko', label: '한국어' },
  { value: 'en', label: '영어' },
  { value: 'ja', label: '일본어' },
];

export const READER_TRANSLATION_PROVIDERS: ReadonlyArray<{
  value: ReaderTranslationProvider;
  label: string;
}> = [
  { value: 'auto', label: '자동' },
  { value: 'browser', label: '브라우저 내장' },
  { value: 'google', label: 'Google Translate' },
  { value: 'papago', label: 'Papago' },
];

export const READER_DICTIONARY_PROVIDERS: ReadonlyArray<{
  value: ReaderDictionaryProvider;
  label: string;
}> = [
  { value: 'naver', label: 'Naver Dictionary' },
  { value: 'wiktionary', label: 'Wiktionary' },
];

const readerLanguages = new Set<ReaderLanguage>(['ko', 'en', 'ja']);
const sourceLanguages = new Set<ReaderTranslationSourceLanguage>(['auto', 'ko', 'en', 'ja']);
const translationProviders = new Set<ReaderTranslationProvider>([
  'auto',
  'browser',
  'google',
  'papago',
]);
const dictionaryProviders = new Set<ReaderDictionaryProvider>(['naver', 'wiktionary']);

export const normalizeReaderLanguage = (
  value: unknown,
  fallback: ReaderLanguage,
): ReaderLanguage => readerLanguages.has(value as ReaderLanguage)
  ? value as ReaderLanguage
  : fallback;

export const normalizeReaderTranslationSourceLanguage = (
  value: unknown,
): ReaderTranslationSourceLanguage => sourceLanguages.has(
  value as ReaderTranslationSourceLanguage,
) ? value as ReaderTranslationSourceLanguage : 'auto';

export const normalizeReaderTranslationProvider = (
  value: unknown,
): ReaderTranslationProvider => translationProviders.has(value as ReaderTranslationProvider)
  ? value as ReaderTranslationProvider
  : 'auto';

export const normalizeReaderDictionaryProvider = (
  value: unknown,
): ReaderDictionaryProvider => dictionaryProviders.has(value as ReaderDictionaryProvider)
  ? value as ReaderDictionaryProvider
  : 'naver';

export const inferReaderLanguage = (text: string): ReaderLanguage | null => {
  const normalized = text.normalize('NFKC');
  if (/\p{Script=Hangul}/u.test(normalized)) return 'ko';
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(normalized)) return 'ja';
  if (/\p{Script=Latin}/u.test(normalized)) return 'en';
  return null;
};

export const resolveReaderSourceLanguage = (
  configured: ReaderTranslationSourceLanguage,
  text: string,
) => configured === 'auto' ? inferReaderLanguage(text) : configured;

export const hasSameReaderTranslationLanguage = (
  sourceLanguage: ReaderLanguage | null,
  targetLanguage: ReaderLanguage,
) => sourceLanguage !== null && sourceLanguage === targetLanguage;

export const getReaderTranslationRoute = ({
  provider,
  browserTranslatorExposed,
  sourceLanguage,
}: {
  provider: ReaderTranslationProvider;
  browserTranslatorExposed: boolean;
  sourceLanguage: ReaderLanguage | null;
}): 'browser' | 'google' | 'papago' => {
  if (provider === 'google' || provider === 'papago') return provider;
  if (provider === 'browser') return 'browser';
  return browserTranslatorExposed && sourceLanguage ? 'browser' : 'google';
};

export type ReaderLanguageToolValidation =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too-long' };

export const validateReaderLanguageToolText = (
  text: string,
  kind: 'translation' | 'dictionary',
): ReaderLanguageToolValidation => {
  const normalized = text.trim();
  if (!normalized) return { ok: false, reason: 'empty' };
  const limit = kind === 'translation'
    ? READER_TRANSLATION_TEXT_MAX_LENGTH
    : READER_DICTIONARY_TEXT_MAX_LENGTH;
  return normalized.length <= limit
    ? { ok: true, text: normalized }
    : { ok: false, reason: 'too-long' };
};

const naverDictionaryOrigin = (language: ReaderLanguage | null) => {
  if (language === 'ko') return 'https://ko.dict.naver.com';
  if (language === 'ja') return 'https://ja.dict.naver.com';
  return 'https://en.dict.naver.com';
};

export const buildReaderTranslationUrl = ({
  provider,
  text,
  sourceLanguage,
  targetLanguage,
}: {
  provider: Exclude<ReaderTranslationProvider, 'auto' | 'browser'>;
  text: string;
  sourceLanguage: ReaderLanguage | null;
  targetLanguage: ReaderLanguage;
}) => {
  if (provider === 'papago') {
    const url = new URL('https://papago.naver.com/');
    url.searchParams.set('sk', sourceLanguage ?? 'auto');
    url.searchParams.set('tk', targetLanguage);
    url.searchParams.set('st', text);
    return url.toString();
  }
  const url = new URL('https://translate.google.com/');
  url.searchParams.set('sl', sourceLanguage ?? 'auto');
  url.searchParams.set('tl', targetLanguage);
  url.searchParams.set('text', text);
  url.searchParams.set('op', 'translate');
  return url.toString();
};

export const buildReaderDictionaryUrl = ({
  provider,
  text,
  sourceLanguage,
}: {
  provider: ReaderDictionaryProvider;
  text: string;
  sourceLanguage: ReaderLanguage | null;
}) => {
  if (provider === 'wiktionary') {
    const locale = sourceLanguage ?? 'en';
    const url = new URL(`https://${locale}.wiktionary.org/w/index.php`);
    url.searchParams.set('search', text);
    return url.toString();
  }
  if (!sourceLanguage) {
    const url = new URL('https://dict.naver.com/search.dict');
    url.searchParams.set('dicQuery', text);
    return url.toString();
  }
  const url = new URL('/', naverDictionaryOrigin(sourceLanguage));
  url.hash = `/search?query=${encodeURIComponent(text)}`;
  return url.toString();
};

export const buildTranslationAnnotationNote = ({
  existingNote,
  translatedText,
  sourceLanguage,
  targetLanguage,
}: {
  existingNote: string;
  translatedText: string;
  sourceLanguage: ReaderLanguage;
  targetLanguage: ReaderLanguage;
}) => {
  const block = `[번역 ${sourceLanguage}→${targetLanguage}]\n${translatedText.trim()}`;
  const existing = existingNote.trim();
  if (existing === block || existing.endsWith(`\n\n${block}`)) return existing;
  const next = existing ? `${existing}\n\n${block}` : block;
  return next.length <= ANNOTATION_NOTE_MAX_LENGTH ? next : null;
};

export const getTranslationAnnotationSaveUnavailableReason = ({
  selectionText,
  translatedText,
  sourceLanguage,
  targetLanguage,
}: {
  selectionText: string;
  translatedText: string;
  sourceLanguage: ReaderLanguage;
  targetLanguage: ReaderLanguage;
}) => {
  if (selectionText.length > ANNOTATION_QUOTE_MAX_LENGTH) {
    return '4,000자를 넘는 선택은 번역할 수 있지만 하이라이트 메모로 저장할 수 없습니다.';
  }
  return buildTranslationAnnotationNote({
    existingNote: '',
    translatedText,
    sourceLanguage,
    targetLanguage,
  }) === null
    ? '번역 결과가 메모 최대 길이를 넘어 하이라이트로 저장할 수 없습니다.'
    : null;
};

type ExternalWindowHandle = {
  opener: unknown;
  close?: () => void;
};

export const openReaderLanguageToolUrl = (
  url: string,
  openWindow: (url: string, target: string) => ExternalWindowHandle | null = (
    nextUrl,
    target,
  ) => window.open(nextUrl, target),
) => {
  const opened = openWindow(url, '_blank');
  if (!opened) return false;
  try {
    opened.opener = null;
    return true;
  } catch {
    opened.close?.();
    return false;
  }
};
