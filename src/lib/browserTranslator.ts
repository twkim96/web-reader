import type { ReaderLanguage } from '../types.ts';

export type BrowserTranslationAvailability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

type BrowserTranslatorInstance = {
  translate: (text: string, options?: { signal?: AbortSignal }) => Promise<string>;
  destroy?: () => void;
};

type BrowserTranslatorConstructor = {
  availability: (options: {
    sourceLanguage: ReaderLanguage;
    targetLanguage: ReaderLanguage;
  }) => Promise<BrowserTranslationAvailability>;
  create: (options: {
    sourceLanguage: ReaderLanguage;
    targetLanguage: ReaderLanguage;
    signal?: AbortSignal;
    monitor?: (monitor: {
      addEventListener: (
        type: 'downloadprogress',
        listener: (event: { loaded: number }) => void,
      ) => void;
    }) => void;
  }) => Promise<BrowserTranslatorInstance>;
};

const getBrowserTranslator = () => (
  (globalThis as typeof globalThis & { Translator?: BrowserTranslatorConstructor }).Translator
);

export const isBrowserTranslatorExposed = () => Boolean(getBrowserTranslator());

export class BrowserTranslationUnavailableError extends Error {
  code = 'browser-translator-unavailable' as const;

  constructor() {
    super('이 브라우저에서는 해당 언어의 내장 번역을 사용할 수 없습니다.');
  }
}

export const translateWithBrowser = async ({
  text,
  sourceLanguage,
  targetLanguage,
  signal,
  onAvailability,
  onDownloadProgress,
}: {
  text: string;
  sourceLanguage: ReaderLanguage;
  targetLanguage: ReaderLanguage;
  signal: AbortSignal;
  onAvailability?: (availability: BrowserTranslationAvailability) => void;
  onDownloadProgress?: (progress: number) => void;
}) => {
  const Translator = getBrowserTranslator();
  if (!Translator) throw new BrowserTranslationUnavailableError();
  const options = { sourceLanguage, targetLanguage };
  const availability = await Translator.availability(options);
  onAvailability?.(availability);
  if (availability === 'unavailable') throw new BrowserTranslationUnavailableError();
  signal.throwIfAborted();
  const translator = await Translator.create({
    ...options,
    signal,
    monitor: availability === 'available' ? undefined : (monitor) => {
      monitor.addEventListener('downloadprogress', (event) => {
        onDownloadProgress?.(Math.min(1, Math.max(0, event.loaded)));
      });
    },
  });
  try {
    signal.throwIfAborted();
    return await translator.translate(text, { signal });
  } finally {
    translator.destroy?.();
  }
};
