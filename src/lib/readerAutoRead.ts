export type AutoReadWord = {
  text: string;
  start: number;
  end: number;
};

const DEFAULT_WPM = 330;
const MIN_WPM = 60;
const MAX_WPM = 1_000;

const CLOSING_PUNCTUATION = /["'’”»›)\]}）］｝〕〉》」』】〗〙〛]*$/u;
const SENTENCE_ENDING_PUNCTUATION = new Set(['.', '!', '?', '。', '！', '？']);
const PAUSE_PUNCTUATION = new Set([',', ';', ':', '，', '、', '；', '：']);

const terminalPunctuation = (word: string): string => {
  const withoutClosers = word.replace(CLOSING_PUNCTUATION, '');
  return Array.from(withoutClosers).pop() ?? '';
};

export const tokenizeAutoReadText = (text: string): AutoReadWord[] => {
  const words: AutoReadWord[] = [];
  const matcher = /\S+/gu;
  for (const match of text.matchAll(matcher)) {
    const start = match.index;
    const value = match[0];
    words.push({ text: value, start, end: start + value.length });
  }
  return words;
};

export const getAutoReadWordDelay = (word: string, wpm: number): number => {
  const normalizedWpm = Number.isFinite(wpm)
    ? Math.min(MAX_WPM, Math.max(MIN_WPM, wpm))
    : DEFAULT_WPM;
  const baseDelay = 60_000 / normalizedWpm;
  const punctuation = terminalPunctuation(word);
  if (SENTENCE_ENDING_PUNCTUATION.has(punctuation)) return baseDelay * 2;
  if (PAUSE_PUNCTUATION.has(punctuation)) return baseDelay * 1.5;
  return baseDelay;
};

const splitGraphemes = (text: string): string[] => {
  if (typeof Intl.Segmenter === 'function') {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
      (part) => part.segment,
    );
  }
  return Array.from(text);
};

export const splitAutoReadFocus = (word: string): {
  before: string;
  focus: string;
  after: string;
} => {
  const graphemes = splitGraphemes(word);
  if (graphemes.length === 0) return { before: '', focus: '', after: '' };
  const focusIndex = Math.floor((graphemes.length - 1) / 2);
  return {
    before: graphemes.slice(0, focusIndex).join(''),
    focus: graphemes[focusIndex],
    after: graphemes.slice(focusIndex + 1).join(''),
  };
};
