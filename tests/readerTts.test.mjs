import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReaderTtsChapterEndAction,
  normalizeReaderTtsLanguage,
  normalizeReaderTtsRate,
  normalizeReaderTtsVoiceUri,
  READER_TTS_UTTERANCE_MAX_LENGTH,
  resolveReaderTtsLanguageTag,
  segmentReaderTtsText,
  selectReaderTtsVoice,
  sortReaderTtsVoices,
} from '../src/lib/readerTts.ts';
import {
  getBrowserSpeechErrorMessage,
  isRetryableBrowserSpeechError,
  readBrowserSpeechVoices,
  startBrowserSpeech,
} from '../src/lib/browserSpeechSynthesis.ts';

test('segments Korean, English, and Japanese sentences and bounds long utterances', () => {
  const segments = segmentReaderTtsText('첫 문장입니다. Second sentence! 三つ目です。');
  assert.deepEqual(segments.map(({ text }) => text), [
    '첫 문장입니다.',
    'Second sentence!',
    '三つ目です。',
  ]);

  const long = segmentReaderTtsText(`Start ${'word '.repeat(500)}end.`);
  assert.ok(long.length > 1);
  assert.ok(long.every(({ text }) => text.length <= READER_TTS_UTTERANCE_MAX_LENGTH));
  assert.equal(long.map(({ text }) => text).join(' ').replaceAll(/\s+/g, ' ').trim().startsWith('Start'), true);
});

test('normalizes TTS settings and resolves automatic language tags', () => {
  assert.equal(normalizeReaderTtsLanguage('ja-JP'), 'ja-JP');
  assert.equal(normalizeReaderTtsLanguage('fr-FR'), 'auto');
  assert.equal(normalizeReaderTtsRate(0.1), 0.5);
  assert.equal(normalizeReaderTtsRate(1.26), 1.3);
  assert.equal(normalizeReaderTtsRate(9), 2);
  assert.equal(normalizeReaderTtsRate('1.4'), 1);
  assert.equal(normalizeReaderTtsVoiceUri('voice-1'), 'voice-1');
  assert.equal(normalizeReaderTtsVoiceUri('x'.repeat(501)), '');
  assert.equal(normalizeReaderTtsChapterEndAction('next'), 'next');
  assert.equal(normalizeReaderTtsChapterEndAction('stop'), 'stop');
  assert.equal(normalizeReaderTtsChapterEndAction('unknown'), 'next');
  assert.equal(resolveReaderTtsLanguageTag({
    configured: 'auto',
    text: '한국어 문장',
  }), 'ko-KR');
  assert.equal(resolveReaderTtsLanguageTag({
    configured: 'auto',
    text: '漢字',
    documentLanguage: 'zh-TW',
  }), 'zh-TW');
  assert.equal(resolveReaderTtsLanguageTag({
    configured: 'en-US',
    text: '한국어',
  }), 'en-US');
});

test('prefers an explicit voice then exact and base-language local voices', () => {
  const voices = [
    { voiceURI: 'default', name: 'Default', lang: 'en-GB', default: true, localService: false },
    { voiceURI: 'ko-cloud', name: 'Korean Cloud', lang: 'ko-KR', default: false, localService: false },
    { voiceURI: 'ko-local', name: 'Korean Local', lang: 'ko-KR', default: false, localService: true },
  ];
  assert.equal(sortReaderTtsVoices(voices)[0].voiceURI, 'default');
  assert.equal(selectReaderTtsVoice(voices, 'ko-cloud', 'ko-KR').voiceURI, 'ko-cloud');
  assert.equal(selectReaderTtsVoice(voices, '', 'ko-KR').voiceURI, 'ko-local');
  assert.equal(selectReaderTtsVoice(voices, '', 'ko').voiceURI, 'ko-local');
  assert.equal(selectReaderTtsVoice(voices, '', 'ja-JP').voiceURI, 'default');
});

test('configures one browser utterance and forwards lifecycle events', () => {
  const events = [];
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.lang = '';
      this.rate = 1;
      this.voice = null;
    }
  }
  const voice = { voiceURI: 'ko', name: 'Korean', lang: 'ko-KR' };
  const synthesis = new EventTarget();
  synthesis.getVoices = () => [voice];
  synthesis.cancel = () => events.push('cancel');
  synthesis.pause = () => events.push('pause');
  synthesis.resume = () => events.push('resume');
  synthesis.speak = (utterance) => {
    events.push('speak');
    utterance.onstart();
    utterance.onend();
  };
  const dependencies = { synthesis, Utterance: FakeUtterance };
  assert.deepEqual(readBrowserSpeechVoices(dependencies), [voice]);
  const utterance = startBrowserSpeech({
    text: '안녕하세요.',
    language: 'ko-KR',
    rate: 1.2,
    voice,
    onStart: () => events.push('start'),
    onEnd: () => events.push('end'),
    onError: (error) => events.push(error),
  }, dependencies);
  assert.equal(utterance.text, '안녕하세요.');
  assert.equal(utterance.lang, 'ko-KR');
  assert.equal(utterance.rate, 1.2);
  assert.equal(utterance.voice, voice);
  assert.deepEqual(events, ['speak', 'start', 'end']);
});

test('maps browser speech errors to actionable reader messages', () => {
  assert.match(getBrowserSpeechErrorMessage('not-allowed'), /권한/);
  assert.match(getBrowserSpeechErrorMessage('voice-unavailable'), /음성/);
  assert.match(getBrowserSpeechErrorMessage('audio-busy'), /오디오/);
  assert.match(getBrowserSpeechErrorMessage(new Error('speech-synthesis-unavailable')), /지원하지/);
  assert.equal(isRetryableBrowserSpeechError('network'), true);
  assert.equal(isRetryableBrowserSpeechError(new Error('audio-hardware')), true);
  assert.equal(isRetryableBrowserSpeechError('not-allowed'), false);
});
