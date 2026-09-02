// src/components/ConfirmDialog.tsx
import React, { useEffect, useId, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface ConfirmDialogProps {
  message: string;
  subMessage?: React.ReactNode; // [Modified] string -> ReactNode
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  dismissible?: boolean;
  variant?: 'danger' | 'info';
  theme: { bg: string; text: string; border: string; secondary: string };
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  message,
  subMessage,
  confirmLabel = '확인',
  cancelLabel = '취소',
  hideCancel = false,
  dismissible: dismissibleProp,
  variant = 'danger',
  theme,
  onConfirm,
  onCancel,
}) => {
  useBodyScrollLock();

  const isDanger = variant === 'danger';
  const dismissible = dismissibleProp ?? !hideCancel;
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const onCancelRef = useRef(onCancel);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusableSelector = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!dismissible) return;
        event.preventDefault();
        onCancelRef.current();
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
  }, [dismissible]);

  const handleBackdropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    backdropPointerIdRef.current = dismissible && event.target === event.currentTarget
      ? event.pointerId
      : null;
  };

  const handleBackdropPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const shouldDismiss = dismissible
      && backdropPointerIdRef.current === event.pointerId
      && event.target === event.currentTarget;
    backdropPointerIdRef.current = null;
    if (shouldDismiss) onCancel();
  };

  const clearBackdropPointer = () => {
    backdropPointerIdRef.current = null;
  };

  return (
    <div
      data-confirm-dialog-backdrop="true"
      data-menu-sheet-backdrop="true"
      className="app-menu-sheet-backdrop fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={clearBackdropPointer}
      onLostPointerCapture={clearBackdropPointer}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        data-menu-sheet="true"
        data-confirm-dialog-surface="true"
        aria-labelledby={titleId}
        aria-describedby={subMessage ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`app-panel-radius app-menu-sheet w-full max-w-xs ${theme.bg} ${theme.text} p-4 shadow-2xl border ${theme.border} animate-in zoom-in-95 duration-200 space-y-3`}
      >
        <div
          data-confirm-dialog-section="true"
          className={`app-menu-sheet-section flex flex-col items-center gap-3 rounded-2xl border ${theme.border} p-4 text-center`}
        >
          <div className={`app-menu-sheet-action rounded-2xl border p-3 ${isDanger ? 'app-menu-dialog-danger' : 'app-menu-dialog-info'}`}>
            {isDanger ? (
              <AlertTriangle size={22} />
            ) : (
              <div className="w-5.5 h-5.5 border-2 border-current rounded-full flex items-center justify-center font-bold text-xs italic">i</div>
            )}
          </div>
          <p id={titleId} className="text-sm font-bold leading-relaxed">{message}</p>
          {subMessage && (
            <p id={descriptionId} className="text-xs font-bold opacity-80 leading-relaxed">{subMessage}</p>
          )}
        </div>
        <div className="flex gap-3">
          {!hideCancel && (
            <button
              type="button"
              onClick={onCancel}
              data-confirm-dialog-action="cancel"
              className={`app-menu-sheet-action flex-1 rounded-2xl border ${theme.border} py-3 text-sm font-bold transition-colors active:scale-95`}
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            data-confirm-dialog-action="confirm"
            className={`app-menu-sheet-action ${hideCancel ? 'w-full' : 'flex-1'} rounded-2xl border py-3 text-sm font-bold transition-all active:scale-95 ${
              isDanger ? 'app-menu-dialog-danger' : 'app-menu-dialog-info'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
