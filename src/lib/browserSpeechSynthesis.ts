import type { ReaderTtsVoiceLike } from './readerTts.ts';

export type BrowserSpeechSynthesisDependencies = {
  synthesis: Pick<
    SpeechSynthesis,
    'speak' | 'cancel' | 'pause' | 'resume' | 'getVoices' | 'addEventListener' | 'removeEventListener'
  > & Partial<Pick<SpeechSynthesis, 'speaking' | 'paused' | 'pending'>>;
  Utterance: typeof SpeechSynthesisUtterance;
};

export const getBrowserSpeechSynthesisDependencies = ():
  BrowserSpeechSynthesisDependencies | null => {
  if (
    typeof window === 'undefined'
    || !window.speechSynthesis
    || typeof window.SpeechSynthesisUtterance !== 'function'
  ) return null;
  return {
    synthesis: window.speechSynthesis,
    Utterance: window.SpeechSynthesisUtterance,
  };
};

export const isBrowserSpeechSynthesisAvailable = () => (
  getBrowserSpeechSynthesisDependencies() !== null
);

export const readBrowserSpeechVoices = (
  dependencies = getBrowserSpeechSynthesisDependencies(),
) => dependencies?.synthesis.getVoices() ?? [];

export type StartBrowserSpeechOptions = {
  text: string;
  language: string;
  rate: number;
  voice?: ReaderTtsVoiceLike | null;
  onStart: () => void;
  onEnd: () => void;
  onError: (error: string) => void;
};

export const startBrowserSpeech = (
  options: StartBrowserSpeechOptions,
  dependencies = getBrowserSpeechSynthesisDependencies(),
) => {
  if (!dependencies) throw new Error('speech-synthesis-unavailable');
  const utterance = new dependencies.Utterance(options.text);
  utterance.lang = options.language;
  utterance.rate = options.rate;
  if (options.voice) utterance.voice = options.voice as SpeechSynthesisVoice;
  utterance.onstart = options.onStart;
  utterance.onend = options.onEnd;
  utterance.onerror = (event) => options.onError(event.error || 'speech-error');
  dependencies.synthesis.speak(utterance);
  return utterance;
};

export const getBrowserSpeechErrorMessage = (error: unknown) => {
  const code = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : 'speech-error';
  if (code === 'not-allowed') return '음성 재생 권한이 없습니다. 듣기 버튼을 다시 눌러 주세요.';
  if (code === 'language-unavailable' || code === 'voice-unavailable') {
    return '선택한 언어 또는 음성을 사용할 수 없습니다. 다른 음성을 선택해 주세요.';
  }
  if (code === 'audio-busy' || code === 'audio-hardware') {
    return '현재 오디오 출력을 사용할 수 없습니다.';
  }
  if (code === 'text-too-long') return '현재 문장이 음성 엔진 제한을 초과했습니다.';
  if (code === 'speech-synthesis-unavailable') return '이 브라우저에서는 TTS를 지원하지 않습니다.';
  return '음성 재생을 완료하지 못했습니다.';
};

const retryableSpeechErrors = new Set([
  'audio-busy',
  'audio-hardware',
  'interrupted',
  'network',
  'synthesis-failed',
]);

export const isRetryableBrowserSpeechError = (error: unknown) => {
  const code = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '';
  return retryableSpeechErrors.has(code);
};
