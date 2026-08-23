'use client';

import React from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Square,
  Timer,
  Volume2,
} from 'lucide-react';
import type { ThemeClasses, ViewerSettings } from '../../types';
import type { ReaderTtsPresentationState } from '../../hooks/reader/useReaderTts';
import {
  normalizeReaderTtsRate,
  READER_TTS_LANGUAGE_OPTIONS,
} from '../../lib/readerTts';

const languageBase = (language: string) => language.toLowerCase().split('-')[0];

export const ReaderTtsControls = ({
  state,
  voices,
  settings,
  theme,
  onUpdateSettings,
  onTogglePause,
  onPrevious,
  onNext,
  onStop,
  canPrevious,
  canNext,
  windowSize,
  resumeAvailable,
  sleepTimerEndsAt,
  sleepTimerMinutes,
  onStartChapter,
  onResumeChapter,
  onSetSleepTimer,
}: {
  state: ReaderTtsPresentationState;
  voices: SpeechSynthesisVoice[];
  settings: ViewerSettings;
  theme: ThemeClasses;
  onUpdateSettings: (settings: Partial<ViewerSettings>) => void;
  onTogglePause: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onStop: () => void;
  canPrevious: boolean;
  canNext: boolean;
  windowSize: number;
  resumeAvailable: boolean;
  sleepTimerEndsAt: number | null;
  sleepTimerMinutes: 10 | 20 | 30 | null;
  onStartChapter: () => void;
  onResumeChapter: () => void;
  onSetSleepTimer: (minutes: 0 | 10 | 20 | 30) => void;
}) => {
  const languageVoices = settings.ttsLanguage === 'auto'
    ? voices
    : voices.filter(({ lang }) => languageBase(lang) === languageBase(settings.ttsLanguage));
  const selectedVoice = voices.find(({ voiceURI }) => voiceURI === settings.ttsVoiceURI);
  const visibleVoices = selectedVoice && !languageVoices.includes(selectedVoice)
    ? [selectedVoice, ...languageVoices]
    : languageVoices;
  const statusLabel = state.status === 'loading'
    ? '다음 문장 준비 중'
    : state.status === 'starting'
      ? '음성 시작 대기 중'
    : state.status === 'paused'
    ? '일시정지'
    : state.status === 'finished'
      ? state.mode === 'chapter' ? '현재 장 완료' : '문장 완료'
      : state.status === 'error'
        ? '재생 오류'
        : state.mode === 'selection'
          ? '선택 영역 읽는 중'
          : state.mode === 'chapter'
            ? '현재 장 연속 읽는 중'
            : '현재 문장 읽는 중';
  return (
    <section
      data-reader-tts-controls="true"
      data-reader-tts-index={state.index}
      data-reader-tts-total={state.total}
      data-reader-tts-window-size={windowSize}
      aria-label="텍스트 음성 읽기"
      className={`app-panel-radius fixed bottom-[calc(env(safe-area-inset-bottom)+2.25rem)] left-1/2 z-[85] max-h-[calc(100dvh_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom)_-_3rem)] w-[min(28rem,calc(100vw-1rem))] -translate-x-1/2 overflow-y-auto overscroll-contain border ${theme.border} ${theme.bg} ${theme.text} p-3 font-sans shadow-2xl`}
    >
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-500">
          <Volume2 size={21} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-wider opacity-55">
            <span>{statusLabel}</span>
            <span>{state.index + 1}/{state.total}</span>
          </div>
          <p className="mt-1 overflow-hidden text-sm font-bold leading-5 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
            {state.text}
          </p>
        </div>
      </div>

      {state.error && (
        <p role="alert" className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-500">
          {state.error}
        </p>
      )}

      <div className="mt-3 grid grid-cols-4 gap-2">
        <button
          type="button"
          onClick={onPrevious}
          disabled={!canPrevious}
          aria-label="이전 문장"
          className={`flex min-h-11 items-center justify-center rounded-xl border ${theme.border} disabled:opacity-30`}
        >
          <ChevronLeft size={20} />
        </button>
        <button
          type="button"
          onClick={onTogglePause}
          disabled={state.status === 'loading'}
          aria-label={state.status === 'playing' || state.status === 'starting' ? '일시정지' : '재생'}
          className="flex min-h-11 items-center justify-center rounded-xl bg-accent-500 font-bold text-white disabled:opacity-40"
        >
          {state.status === 'playing' || state.status === 'starting' ? <Pause size={19} /> : <Play size={19} />}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          aria-label="다음 문장"
          className={`flex min-h-11 items-center justify-center rounded-xl border ${theme.border} disabled:opacity-30`}
        >
          <ChevronRight size={20} />
        </button>
        <button
          type="button"
          onClick={onStop}
          aria-label="TTS 중지"
          className={`flex min-h-11 items-center justify-center rounded-xl border ${theme.border}`}
        >
          <Square size={17} />
        </button>
      </div>

      {state.mode !== 'chapter' && (
        <div className={`mt-2 grid ${resumeAvailable ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
          <button
            type="button"
            onClick={onStartChapter}
            className={`min-h-11 rounded-xl border ${theme.border} px-3 text-xs font-bold`}
          >
            현재 장 연속 듣기
          </button>
          {resumeAvailable && (
            <button
              type="button"
              onClick={onResumeChapter}
              className="min-h-11 rounded-xl bg-accent-500/15 px-3 text-xs font-bold text-accent-500"
            >
              저장 위치 이어 듣기
            </button>
          )}
        </div>
      )}

      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer select-none px-2 py-3 text-xs font-bold opacity-60">
          음성·언어·속도
        </summary>
        <div className="grid gap-3 px-1 pb-1 sm:grid-cols-2">
          <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider opacity-70">
            언어
            <select
              value={settings.ttsLanguage}
              onChange={(event) => onUpdateSettings({
                ttsLanguage: event.target.value as ViewerSettings['ttsLanguage'],
                ttsVoiceURI: '',
              })}
              className={`min-h-11 rounded-xl border ${theme.border} ${theme.bg} px-3 text-xs font-bold normal-case tracking-normal outline-none`}
            >
              {READER_TTS_LANGUAGE_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider opacity-70">
            음성
            <select
              value={settings.ttsVoiceURI}
              onChange={(event) => onUpdateSettings({ ttsVoiceURI: event.target.value })}
              className={`min-h-11 min-w-0 rounded-xl border ${theme.border} ${theme.bg} px-3 text-xs font-bold normal-case tracking-normal outline-none`}
            >
              <option value="">언어에 맞게 자동 선택</option>
              {visibleVoices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} · {voice.lang}{voice.localService ? ' · 기기' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider opacity-70 sm:col-span-2">
            속도 {settings.ttsRate.toFixed(1)}×
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={settings.ttsRate}
              onChange={(event) => onUpdateSettings({
                ttsRate: normalizeReaderTtsRate(Number(event.target.value)),
              })}
              className="min-h-11 w-full accent-accent-500"
            />
          </label>
          <label className="grid gap-1 text-[10px] font-black uppercase tracking-wider opacity-70 sm:col-span-2">
            장 끝 동작
            <select
              value={settings.ttsChapterEndAction}
              onChange={(event) => onUpdateSettings({
                ttsChapterEndAction: event.target.value as ViewerSettings['ttsChapterEndAction'],
              })}
              className={`min-h-11 rounded-xl border ${theme.border} ${theme.bg} px-3 text-xs font-bold normal-case tracking-normal outline-none`}
            >
              <option value="stop">현재 장에서 멈춤</option>
              <option value="next">다음 장 계속 듣기</option>
            </select>
          </label>
          <div className="grid gap-2 sm:col-span-2">
            <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider opacity-70">
              <Timer size={14} />
              취침 타이머{sleepTimerMinutes === null ? '' : ` · ${sleepTimerMinutes}분 설정`}
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {([0, 10, 20, 30] as const).map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => onSetSleepTimer(minutes)}
                  data-reader-tts-sleep-active={(
                    (minutes === 0 && sleepTimerEndsAt === null)
                    || (minutes > 0 && sleepTimerEndsAt !== null && minutes === sleepTimerMinutes)
                  ) || undefined}
                  className={`min-h-11 rounded-xl border ${theme.border} text-xs font-bold ${
                    (minutes === 0 && sleepTimerEndsAt === null)
                    || (minutes > 0 && sleepTimerEndsAt !== null && minutes === sleepTimerMinutes)
                      ? 'text-accent-500'
                      : ''
                  }`}
                >
                  {minutes === 0 ? '끔' : `${minutes}분`}
                </button>
              ))}
            </div>
          </div>
          {voices.length === 0 && (
            <p role="status" className="text-[11px] font-bold opacity-55 sm:col-span-2">
              기기 음성 목록을 불러오는 중입니다. 준비되면 자동으로 갱신됩니다.
            </p>
          )}
        </div>
      </details>
    </section>
  );
};
