'use client';

import React, { useEffect, useRef } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';

type ReaderTheme = {
  bg: string;
  text?: string;
  border: string;
};

interface ProgressJumpConfirmDialogProps {
  theme: ReaderTheme;
  targetPercent: number;
  targetChapter?: string;
  onCancel: () => void;
  onConfirm: () => void;
  resolving?: boolean;
}

export const ProgressJumpConfirmDialog: React.FC<ProgressJumpConfirmDialogProps> = ({
  theme,
  targetPercent,
  targetChapter,
  onCancel,
  onConfirm,
  resolving = false,
}) => {
  useBodyScrollLock();
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const backdropClickArmedRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusableSelector = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (resolving) return;
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => element.getClientRects().length > 0);
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
    const focusFrame = window.requestAnimationFrame(() => {
      (dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog)?.focus();
    });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [onCancel, resolving]);

  const handleBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    backdropClickArmedRef.current = false;
    backdropPointerIdRef.current = !resolving && event.target === event.currentTarget
      ? event.pointerId
      : null;
  };

  const handleBackdropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    backdropClickArmedRef.current = !resolving
      && backdropPointerIdRef.current === event.pointerId
      && event.target === event.currentTarget;
    backdropPointerIdRef.current = null;
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const shouldCancel = backdropClickArmedRef.current
      && event.target === event.currentTarget;
    backdropClickArmedRef.current = false;
    if (!shouldCancel) return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  const clearBackdropPointer = () => {
    backdropPointerIdRef.current = null;
    backdropClickArmedRef.current = false;
  };

  return (
    <div
      data-progress-jump-confirm-backdrop="true"
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onClick={handleBackdropClick}
      onPointerCancel={clearBackdropPointer}
      onLostPointerCapture={clearBackdropPointer}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="progress-jump-confirm-title"
        aria-describedby="progress-jump-confirm-description"
        aria-busy={resolving}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={`app-panel-radius w-full max-w-[19rem] border p-5 font-sans shadow-2xl ${theme.bg} ${theme.text || ''} ${theme.border}`}
      >
        <div className="space-y-4 text-center">
      <div>
        {targetChapter && (
          <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-55">
            {targetChapter}
          </p>
        )}
        <h3 id="progress-jump-confirm-title" className="mt-2 text-lg font-bold tracking-tight">
          {targetPercent.toFixed(1)}%로 이동할까요?
        </h3>
        <p id="progress-jump-confirm-description" className="mt-2 text-xs leading-5 opacity-60">
          이동이 완료된 뒤 현재 위치와 자동 책갈피를 저장합니다.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={resolving}
          className="h-10 rounded-xl border border-current/10 px-4 text-sm font-bold opacity-70 transition-opacity hover:opacity-100 disabled:opacity-35"
        >
          취소
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={resolving}
          className="h-10 rounded-xl bg-accent-500 px-4 text-sm font-bold text-white transition-colors hover:bg-accent-600 disabled:opacity-50"
        >
          {resolving ? '이동 중…' : '확인'}
        </button>
      </div>
    </div>
      </div>
    </div>
  );
};
