import type { ReaderTtsChapterEndAction, ReaderTtsLanguage } from '../types.ts';
import { inferReaderLanguage } from './readerLanguageTools.ts';

export const READER_TTS_RATE_MIN = 0.5;
export const READER_TTS_RATE_MAX = 2;
export const READER_TTS_UTTERANCE_MAX_LENGTH = 1_000;

export const READER_TTS_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: ReaderTtsLanguage;
  label: string;
}> = [
  { value: 'auto', label: '자동' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'en-US', label: '영어' },
  { value: 'ja-JP', label: '일본어' },
];

const readerTtsLanguages = new Set<ReaderTtsLanguage>([
  'auto',
  'ko-KR',
  'en-US',
  'ja-JP',
]);

export const normalizeReaderTtsLanguage = (value: unknown): ReaderTtsLanguage => (
  readerTtsLanguages.has(value as ReaderTtsLanguage)
    ? value as ReaderTtsLanguage
    : 'auto'
);

export const normalizeReaderTtsRate = (value: unknown) => {
  const numeric = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return 1;
  return Math.round(Math.min(READER_TTS_RATE_MAX, Math.max(READER_TTS_RATE_MIN, numeric)) * 10) / 10;
};

export const normalizeReaderTtsVoiceUri = (value: unknown) => (
  typeof value === 'string' && value.length <= 500 ? value : ''
);

export const normalizeReaderTtsChapterEndAction = (
  value: unknown,
): ReaderTtsChapterEndAction => value === 'stop' ? 'stop' : 'next';

export const READER_TTS_NAVIGATION_REASON = 'tts-navigation';

export const isReaderTtsNavigationReason = (
  reason?: string,
  navigationSource?: string,
) => (
  reason === READER_TTS_NAVIGATION_REASON || navigationSource === 'tts'
);

export type ReaderTtsTextSegment = {
  text: string;
  start: number;
  end: number;
};

const trimSegment = (
  text: string,
  start: number,
  end: number,
): ReaderTtsTextSegment | null => {
  let nextStart = start;
  let nextEnd = end;
  while (nextStart < nextEnd && /\s/u.test(text[nextStart])) nextStart += 1;
  while (nextEnd > nextStart && /\s/u.test(text[nextEnd - 1])) nextEnd -= 1;
  if (nextStart >= nextEnd) return null;
  return {
    text: text.slice(nextStart, nextEnd),
    start: nextStart,
    end: nextEnd,
  };
};

const chunkSegment = (
  source: string,
  segment: ReaderTtsTextSegment,
): ReaderTtsTextSegment[] => {
  if (segment.end - segment.start <= READER_TTS_UTTERANCE_MAX_LENGTH) return [segment];
  const chunks: ReaderTtsTextSegment[] = [];
  let start = segment.start;
  while (start < segment.end) {
    let end = Math.min(segment.end, start + READER_TTS_UTTERANCE_MAX_LENGTH);
    if (end < segment.end) {
      const candidate = source.slice(start, end);
      const whitespace = Math.max(
        candidate.lastIndexOf(' '),
        candidate.lastIndexOf('\n'),
        candidate.lastIndexOf('\t'),
      );
      if (whitespace >= READER_TTS_UTTERANCE_MAX_LENGTH / 2) {
        end = start + whitespace + 1;
      }
    }
    const chunk = trimSegment(source, start, end);
    if (chunk) chunks.push(chunk);
    start = Math.max(end, start + 1);
  }
  return chunks;
};

const fallbackSentenceOffsets = (text: string) => {
  const boundaries: Array<[number, number]> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!/[.!?。！？\n]/u.test(character)) continue;
    let end = index + 1;
    while (end < text.length && /[.!?。！？]/u.test(text[end])) end += 1;
    boundaries.push([start, end]);
    start = end;
    index = end - 1;
  }
  if (start < text.length) boundaries.push([start, text.length]);
  return boundaries;
};

export const segmentReaderTtsText = (
  text: string,
  locale?: string,
): ReaderTtsTextSegment[] => {
  if (!text.trim()) return [];
  let offsets: Array<[number, number]> = [];
  try {
    if (typeof Intl.Segmenter === 'function') {
      const segmented = new Intl.Segmenter(locale || undefined, {
        granularity: 'sentence',
      }).segment(text);
      offsets = [...segmented].map((segment) => [
        segment.index,
        segment.index + segment.segment.length,
      ]);
    }
  } catch {
    offsets = [];
  }
  if (offsets.length === 0) offsets = fallbackSentenceOffsets(text);
  return offsets.flatMap(([start, end]) => {
    const segment = trimSegment(text, start, end);
    return segment ? chunkSegment(text, segment) : [];
  });
};

const inferredLanguageTags = {
  ko: 'ko-KR',
  en: 'en-US',
  ja: 'ja-JP',
} as const;

export const resolveReaderTtsLanguageTag = ({
  configured,
  text,
  documentLanguage,
}: {
  configured: ReaderTtsLanguage;
  text: string;
  documentLanguage?: string;
}) => {
  if (configured !== 'auto') return configured;
  const inferred = inferReaderLanguage(text);
  if (inferred) return inferredLanguageTags[inferred];
  const normalizedDocumentLanguage = documentLanguage?.trim();
  return normalizedDocumentLanguage || '';
};

export type ReaderTtsVoiceLike = {
  voiceURI: string;
  name: string;
  lang: string;
  default?: boolean;
  localService?: boolean;
};

const baseLanguage = (language: string) => language.toLowerCase().split('-')[0];

const readerTtsVoiceLanguageBases = new Set(['ko', 'ja', 'en']);

export const filterReaderTtsVoices = <T extends ReaderTtsVoiceLike>(
  voices: ReadonlyArray<T>,
) => voices.filter(({ lang }) => readerTtsVoiceLanguageBases.has(baseLanguage(lang)));

export const sortReaderTtsVoices = <T extends ReaderTtsVoiceLike>(
  voices: ReadonlyArray<T>,
) => [...voices].sort((left, right) => (
  Number(Boolean(right.default)) - Number(Boolean(left.default))
  || Number(Boolean(right.localService)) - Number(Boolean(left.localService))
  || left.lang.localeCompare(right.lang)
  || left.name.localeCompare(right.name)
));

export const selectReaderTtsVoice = <T extends ReaderTtsVoiceLike>(
  voices: ReadonlyArray<T>,
  preferredVoiceUri: string,
): T | null => {
  if (!preferredVoiceUri) return null;
  return voices.find(({ voiceURI }) => voiceURI === preferredVoiceUri) ?? null;
};
