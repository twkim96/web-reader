'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { Copy, ExternalLink, Languages, Save, X } from 'lucide-react';
import type { ThemeClasses } from '../../types';
import type { ReaderTranslationPanelState } from '../../hooks/reader/useReaderLanguageTools';
import {
  getTranslationAnnotationSaveUnavailableReason,
  hasSameReaderTranslationLanguage,
  READER_LANGUAGE_OPTIONS,
} from '../../lib/readerLanguageTools';
import { ReaderModalFrame } from './ReaderModalFrame';

const languageLabel = (language: ReaderTranslationPanelState['sourceLanguage']) => (
  READER_LANGUAGE_OPTIONS.find(({ value }) => value === language)?.label ?? '자동'
);

export const TranslationDialog = ({
  state,
  theme,
  onClose,
  onCopy,
  onSaveNote,
  onOpenExternal,
  returnFocusRef,
}: {
  state: ReaderTranslationPanelState;
  theme: ThemeClasses;
  onClose: () => void;
  onCopy: () => Promise<boolean>;
  onSaveNote: () => Promise<boolean>;
  onOpenExternal: (provider: 'google' | 'papago') => boolean;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) => {
  const [saving, setSaving] = useState(false);
  const [actionFeedback, setActionFeedback] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const progress = Math.round((state.downloadProgress ?? 0) * 100);
  const success = state.status === 'success' && Boolean(state.translatedText);
  const sameLanguage = hasSameReaderTranslationLanguage(
    state.sourceLanguage,
    state.targetLanguage,
  );
  const saveUnavailableReason = success && state.sourceLanguage
    ? getTranslationAnnotationSaveUnavailableReason({
      selectionText: state.selection.text,
      translatedText: state.translatedText!,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
    })
    : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus = returnFocusRef.current;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => !element.hasAttribute('hidden'));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.requestAnimationFrame(() => returnFocus?.focus());
    };
  }, [onClose, returnFocusRef]);

  const save = async () => {
    if (saving || !success || saveUnavailableReason) return;
    setSaving(true);
    try {
      const saved = await onSaveNote();
      if (!saved) setActionFeedback('하이라이트 메모를 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ReaderModalFrame
      theme={theme}
      onClose={onClose}
      placement="center"
      maxWidth="max-w-xl"
      zIndex="z-[145]"
      className="max-h-[min(90dvh,46rem)] font-sans"
    >
      <div
        ref={dialogRef}
        data-reader-translation-dialog="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-[min(90dvh,46rem)] flex-col outline-none"
      >
        <header className={`flex shrink-0 items-center gap-3 border-b ${theme.border} px-5 py-4`}>
          <Languages size={19} className="shrink-0 text-accent-500" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-black">선택 번역</h2>
            <p className="text-[10px] font-bold opacity-45">
              {languageLabel(state.sourceLanguage)} → {languageLabel(state.targetLanguage)} · 브라우저 내장
            </p>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="번역 닫기" className="flex size-11 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <X size={19} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <h3 className="mb-1 text-[10px] font-black uppercase tracking-wider opacity-45">원문</h3>
            <blockquote className={`max-h-36 overflow-y-auto rounded-2xl border ${theme.border} bg-black/5 px-4 py-3 font-serif text-sm leading-relaxed dark:bg-white/5`}>
              {state.selection.text}
            </blockquote>
          </section>

          <section>
            <h3 className="mb-1 text-[10px] font-black uppercase tracking-wider opacity-45">번역</h3>
            <div className={`min-h-32 rounded-2xl border ${theme.border} bg-black/5 px-4 py-3 text-sm leading-relaxed dark:bg-white/5`}>
              {state.status === 'downloading' ? (
                <div role="status" className="space-y-2 py-3 text-center font-bold opacity-65">
                  <p>번역 언어 모델을 준비하는 중... {progress > 0 ? `${progress}%` : ''}</p>
                  <div className="mx-auto h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-current/10">
                    <div className="h-full bg-accent-500 transition-[width]" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : state.status === 'loading' ? (
                <p role="status" className="py-3 text-center font-bold opacity-55">번역하는 중...</p>
              ) : state.status === 'error' ? (
                <p role="alert" className="py-2 font-bold text-amber-500">{state.error}</p>
              ) : (
                <p className="whitespace-pre-wrap">{state.translatedText}</p>
              )}
            </div>
          </section>

          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={sameLanguage} onClick={() => {
              if (!onOpenExternal('google')) setActionFeedback('새 탭을 열지 못했습니다.');
            }} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-35`}>
              <ExternalLink size={15} /> Google에서 열기
            </button>
            <button type="button" disabled={sameLanguage} onClick={() => {
              if (!onOpenExternal('papago')) setActionFeedback('새 탭을 열지 못했습니다.');
            }} className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border ${theme.border} text-xs font-bold disabled:opacity-35`}>
              <ExternalLink size={15} /> Papago에서 열기
            </button>
          </div>
          {actionFeedback && <p role="status" className="text-center text-[11px] font-bold text-amber-500">{actionFeedback}</p>}
        </div>

        {saveUnavailableReason && (
          <p role="status" className={`shrink-0 border-t ${theme.border} px-5 py-2 text-center text-[11px] font-bold text-amber-500`}>
            {saveUnavailableReason}
          </p>
        )}

        <footer className={`grid shrink-0 grid-cols-2 gap-2 border-t ${theme.border} px-5 py-4`}>
          <button
            type="button"
            disabled={!success}
            onClick={() => void onCopy().then((copied) => {
              setActionFeedback(copied ? '번역 결과를 복사했습니다.' : '복사하지 못했습니다.');
            })}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border ${theme.border} text-sm font-bold disabled:opacity-35`}
          >
            <Copy size={16} /> 결과 복사
          </button>
          <button
            type="button"
            disabled={!success || saving || Boolean(saveUnavailableReason)}
            onClick={() => void save()}
            className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent-500 text-sm font-bold text-white disabled:opacity-35"
          >
            <Save size={16} /> {saving ? '저장 중...' : '하이라이트 메모에 저장'}
          </button>
        </footer>
      </div>
    </ReaderModalFrame>
  );
};
