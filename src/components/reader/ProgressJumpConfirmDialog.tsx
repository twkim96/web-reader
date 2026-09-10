'use client';

import React from 'react';

type ReaderTheme = { bg: string; text?: string; border: string };
interface ProgressJumpConfirmDialogProps {
  theme: ReaderTheme;
  targetPercent: number;
  targetChapter?: string;
  onCancel: () => void;
  onConfirm: () => void;
  resolving?: boolean;
  error?: string | null;
}

// Nonmodal: the reader's controls stay reachable, including by keyboard.
export const ProgressJumpConfirmDialog: React.FC<ProgressJumpConfirmDialogProps> = ({
  theme, targetPercent, targetChapter, onCancel, onConfirm, resolving = false, error,
}) => (
  <div data-progress-jump-confirm-backdrop="true"
    className="pointer-events-none fixed inset-x-0 top-1/2 -translate-y-1/2 z-[65] flex justify-center px-4">
    <div role="dialog" aria-modal="false" aria-labelledby="progress-jump-confirm-title"
      aria-describedby="progress-jump-confirm-description" aria-busy={resolving}
      onClick={(event) => event.stopPropagation()}
      className={`pointer-events-auto app-panel-radius app-reader-menu-surface w-full max-w-[22rem] border p-3 font-sans shadow-xl ${theme.text || ''} ${theme.border}`}>
      <div className="p-3">
        {targetChapter && <p className="truncate text-center text-[10px] opacity-60">{targetChapter}</p>}
        <h3 id="progress-jump-confirm-title" className="text-center text-sm font-bold">
          {targetPercent.toFixed(1)}% · 임시 이동
        </h3>
        <p id="progress-jump-confirm-description" className="mt-1 text-center text-xs opacity-65">
          확인하면 현재 위치를 저장하고,<br />
          취소하면 처음 위치로 돌아갑니다.
        </p>
        {error && <p role="alert" className="mt-2 text-xs text-red-500">{error}</p>}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button type="button" onClick={onCancel} disabled={resolving}
          className="app-menu-sheet-action h-10 rounded-xl border border-current/10 text-sm font-bold opacity-75 disabled:opacity-35">취소</button>
        <button type="button" onClick={onConfirm} disabled={resolving}
          className="app-menu-sheet-action app-menu-dialog-info h-10 rounded-xl border border-accent-500/25 bg-accent-500/10 text-sm font-bold text-accent-500 disabled:opacity-35">
          {resolving ? '처리 중…' : '확인'}
        </button>
      </div>
    </div>
  </div>
);
