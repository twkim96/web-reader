'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, ScanText } from 'lucide-react';
import { ReaderModalFrame } from './ReaderModalFrame';
import { MenuSheetHeader } from '../MenuSheetHeader';
import type { AutoReadContent } from '../../lib/readerAutoReadContent';
import {
  getAutoReadWordDelay,
  splitAutoReadFocus,
} from '../../lib/readerAutoRead';

type Props = {
  content: AutoReadContent;
  chapter: string;
  theme: { bg: string; text: string; border: string };
  fontFamily: string;
  onClose: (position?: { content: AutoReadContent; index: number }) => void;
  loadNextChapter: (sectionIndex: number) => Promise<AutoReadContent | null>;
  registerClose: (close: (() => void) | null) => void;
};

export function ReaderAutoReadModal({ content: initialContent, chapter, theme, fontFamily, onClose, loadNextChapter, registerClose }: Props) {
  const [cursor, setCursor] = useState({ content: initialContent, index: initialContent.initialIndex });
  const { content, index } = cursor;
  const [playing, setPlaying] = useState(false);
  const [wpm, setWpm] = useState(330);
  const [loading, setLoading] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const movedRef = useRef(false);
  const generationRef = useRef(0);
  const word = content.words[index]?.text ?? '';
  const focused = splitAutoReadFocus(word);
  const close = useCallback(() => {
    generationRef.current += 1;
    onClose(movedRef.current ? cursor : undefined);
  }, [cursor, onClose]);

  useEffect(() => {
    registerClose(close);
    return () => registerClose(null);
  }, [close, registerClose]);

  const advance = useCallback(async () => {
    if (index < content.words.length - 1) {
      movedRef.current = true;
      setCursor({ content, index: index + 1 });
      return;
    }
    const generation = ++generationRef.current;
    setLoading(true);
    try {
      const next = await loadNextChapter(content.sectionIndex);
      if (generation !== generationRef.current) return;
      if (next) {
        movedRef.current = true;
        setCursor({ content: next, index: 0 });
      } else {
        setPlaying(false);
        setEnded(true);
      }
    } catch {
      if (generation !== generationRef.current) return;
      setPlaying(false);
      setError('다음 장을 불러오지 못했습니다. 다시 재생해 주세요.');
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [content, index, loadNextChapter]);

  const toggle = useCallback(() => {
    if (loading) return;
    setError('');
    if (ended) {
      setCursor({ content: initialContent, index: initialContent.initialIndex });
      setEnded(false);
    }
    setPlaying((value) => !value);
  }, [ended, initialContent, loading]);

  const seek = useCallback((nextIndex: number) => {
    generationRef.current += 1;
    const clampedIndex = Math.max(0, Math.min(content.words.length - 1, nextIndex));
    if (clampedIndex !== index) movedRef.current = true;
    setLoading(false);
    setPlaying(false);
    setEnded(false);
    setError('');
    setCursor({ content, index: clampedIndex });
  }, [content, index]);

  useEffect(() => {
    if (!playing || loading || !word) return;
    const timer = window.setTimeout(() => {
      void advance();
    }, getAutoReadWordDelay(word, wpm));
    return () => window.clearTimeout(timer);
  }, [advance, loading, playing, word, wpm]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.hidden) {
        generationRef.current += 1;
        setLoading(false);
        setPlaying(false);
      }
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      generationRef.current += 1;
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input,select,textarea,[contenteditable="true"]')) return;
      if (event.key === ' ') {
        if (event.target instanceof Element && event.target.closest('button')) return;
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        seek(index + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, seek, toggle]);

  const buttonClass = `app-menu-sheet-action flex min-h-11 items-center justify-center rounded-xl border ${theme.border} transition-opacity hover:opacity-75 disabled:opacity-30`;
  return (
    <ReaderModalFrame theme={theme} onClose={close} placement="center" maxWidth="max-w-md" ariaLabel="자동읽기" className="app-menu-material max-h-[calc(100dvh-2rem)] overflow-y-auto font-sans">
      <div data-reader-auto-read="true" data-auto-read-index={index} data-auto-read-section={content.sectionIndex} data-auto-read-playing={playing}>
        <MenuSheetHeader
          title="자동읽기"
          onClose={close}
          borderClass={theme.border}
          subtitle={content.sectionIndex === initialContent.sectionIndex ? chapter || '현재 장' : `${content.sectionIndex + 1}번째 장`}
          trailing={<ScanText size={18} className="text-accent-500" />}
        />

        <div tabIndex={0} data-auto-read-stage="true" aria-label="자동읽기 본문" className="relative flex min-h-24 items-center justify-center overflow-hidden px-4 py-4 outline-none sm:min-h-28" style={{ fontFamily }}>
          <div data-auto-read-word="true" className="w-full text-center text-[clamp(2.1rem,8.4vw,2.8rem)] leading-snug [overflow-wrap:anywhere]" aria-label={word}>
            <span className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-baseline">
              <span className="text-right">{focused.before}</span><span className="text-accent-500">{focused.focus}</span><span className="text-left">{focused.after}</span>
            </span>
          </div>
        </div>

        <div className="space-y-3 px-4 pb-4">
          <div>
            <input type="range" aria-label="자동읽기 위치" min={0} max={Math.max(0, content.words.length - 1)} value={index} onChange={(event) => seek(Number(event.target.value))} className="w-full accent-accent-500" />
            <div className="mt-1 flex justify-between gap-2 text-[10px] font-medium opacity-50"><span>{index + 1} / {content.words.length} 단어</span><span>{loading ? '다음 장 불러오는 중…' : ended ? '마지막 장까지 읽었습니다' : '장 끝에서 다음 장으로'}</span></div>
          </div>
          <label className="block text-[11px] font-bold">
            <span className="flex justify-between"><span>속도</span><span className="tabular-nums text-accent-500">{wpm} <span className="text-[10px]">WPM</span></span></span>
            <input type="range" aria-label="자동읽기 속도" min={60} max={1000} step={10} value={wpm} onChange={(event) => setWpm(Number(event.target.value))} className="mt-1 w-full accent-accent-600" />
          </label>
          {error && <p role="alert" className="text-center text-xs text-accent-500">{error}</p>}
          <div className="grid grid-cols-4 gap-2">
            <button type="button" className={buttonClass} onClick={() => seek(0)} aria-label="자동읽기 장 처음으로"><RotateCcw size={18} /></button>
            <button type="button" className={buttonClass} disabled={index === 0 || loading} onClick={() => seek(index - 1)} aria-label="이전 단어"><ChevronLeft size={20} /></button>
            <button type="button" className={`app-menu-sheet-action app-menu-sheet-accent-action flex min-h-11 items-center justify-center rounded-xl border ${theme.border} disabled:opacity-40`} disabled={loading} onClick={toggle} aria-label={playing ? '자동읽기 일시정지' : '자동읽기 재생'}>{playing ? <Pause size={19} /> : <Play size={19} />}</button>
            <button type="button" className={buttonClass} disabled={loading || ended} onClick={() => { setPlaying(false); void advance(); }} aria-label="다음 단어"><ChevronRight size={20} /></button>
          </div>
        </div>
      </div>
    </ReaderModalFrame>
  );
}
