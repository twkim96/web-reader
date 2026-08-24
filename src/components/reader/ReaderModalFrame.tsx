import React, { useEffect, useId, useRef } from 'react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';

type ReaderModalTheme = {
  bg: string;
  text?: string;
  border: string;
};

interface ReaderModalFrameProps {
  theme: ReaderModalTheme;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
  zIndex?: string;
  noBlur?: boolean;
  placement?: 'upper' | 'high' | 'center';
  ariaLabel?: string;
  dismissible?: boolean;
}

export const ReaderModalFrame: React.FC<ReaderModalFrameProps> = ({
  theme,
  onClose,
  children,
  maxWidth = 'max-w-sm',
  className = '',
  zIndex = 'z-[110]',
  noBlur = false,
  placement = 'upper',
  ariaLabel = '리더 대화상자',
  dismissible = true,
}) => {
  useBodyScrollLock();
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPointerIdRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const dialogId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusableSelector = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (!dismissible) return;
        event.preventDefault();
        onCloseRef.current();
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
      (dialog?.querySelector<HTMLElement>('[autofocus]')
        ?? dialog?.querySelector<HTMLElement>(focusableSelector)
        ?? dialog)?.focus();
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
    if (shouldDismiss) onClose();
  };

  const clearBackdropPointer = () => {
    backdropPointerIdRef.current = null;
  };

  const placementClass = placement === 'center'
    ? 'items-center justify-center p-4 sm:p-6'
    : placement === 'high'
      ? 'items-start justify-center overflow-y-auto p-4 pt-[7vh] sm:p-6 sm:pt-[8vh]'
      : 'items-start justify-center overflow-y-auto p-4 pt-[18vh] sm:p-6 sm:pt-[16vh]';

  return (
    <div
      data-reader-modal-backdrop="true"
      className={`fixed inset-0 ${zIndex} flex ${placementClass} ${noBlur ? 'bg-black/20' : 'bg-black/60 backdrop-blur-sm'} animate-in fade-in duration-200`}
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onPointerCancel={clearBackdropPointer}
      onLostPointerCapture={clearBackdropPointer}
    >
      <div
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className={`app-panel-radius w-full ${maxWidth} ${theme.bg} ${theme.text || ''} shadow-2xl border ${theme.border} overflow-hidden animate-in zoom-in-95 duration-200 ${className}`}
      >
        {children}
      </div>
    </div>
  );
};
