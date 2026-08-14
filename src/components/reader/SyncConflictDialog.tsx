'use client';

import React, { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import { SyncConflict } from '../../hooks/reader/useRemoteProgressPrompt';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';

type ReaderTheme = {
  bg: string;
};

interface SyncConflictDialogProps {
  theme: ReaderTheme;
  syncConflict: SyncConflict;
  onDismiss: () => void;
  onAccept: () => void;
  feedback?: string | null;
  resolving?: boolean;
}

export const SyncConflictDialog: React.FC<SyncConflictDialogProps> = ({
  theme,
  syncConflict,
  onDismiss,
  onAccept,
  feedback = null,
  resolving = false,
}) => {
  useBodyScrollLock();
  const dialogRef = useRef<HTMLDivElement>(null);

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
        onDismiss();
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
  }, [onDismiss, resolving]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-progress-dialog-title"
        aria-describedby="remote-progress-dialog-description"
        tabIndex={-1}
        className={`${theme.bg} rounded-2xl p-6 shadow-2xl border border-white/10 w-full max-w-sm`}
      >
        <div className="flex items-center gap-3 text-accent-500 mb-2">
          <RefreshCw size={22} />
          <h3 id="remote-progress-dialog-title" className="text-lg font-bold tracking-tight">클라우드 동기화</h3>
        </div>
      <p id="remote-progress-dialog-description" className="text-sm opacity-80 mb-6 leading-relaxed">
          {syncConflict.operation === 'reset' ? (
            <>클라우드에서 이 책의 읽기 기록이 초기화됐습니다.<br />이 기기의 위치도 처음으로 되돌릴까요?</>
          ) : (
            <>클라우드에 <span className="font-bold text-accent-500">{syncConflict.percent.toFixed(1)}%</span>의 읽기 위치가 있습니다.<br />해당 위치로 이동하시겠습니까?</>
          )}
        </p>
        {feedback && (
          <p role="status" className="mb-4 text-xs font-bold text-amber-500">
            {feedback}
          </p>
        )}
        <div className="flex gap-3">
          <button type="button" disabled={resolving} onClick={onDismiss} className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-gray-500/10 hover:bg-gray-500/20 transition-colors disabled:opacity-40">
            {syncConflict.operation === 'reset' ? '현재 위치 계속 읽기' : '무시'}
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={onAccept}
            className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-lg shadow-accent-500/30 disabled:opacity-40"
          >
            {syncConflict.operation === 'reset' ? '읽기 기록 초기화' : '이동하기'}
          </button>
        </div>
      </div>
    </div>
  );
};
