// src/components/ConfirmDialog.tsx
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface ConfirmDialogProps {
  message: string;
  subMessage?: React.ReactNode; // [Modified] string -> ReactNode
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
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
  variant = 'danger',
  theme,
  onConfirm,
  onCancel,
}) => {
  useBodyScrollLock();

  const isDanger = variant === 'danger';

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-xs ${theme.bg} ${theme.text} rounded-3xl p-6 shadow-2xl border ${theme.border} animate-in zoom-in-95 duration-200 space-y-5`}
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className={`p-3 rounded-2xl ${isDanger ? 'bg-red-500/10 text-red-400' : 'bg-accent-500/10 text-accent-400'}`}>
            {isDanger ? (
              <AlertTriangle size={22} />
            ) : (
              <div className="w-5.5 h-5.5 border-2 border-current rounded-full flex items-center justify-center font-bold text-xs italic">i</div>
            )}
          </div>
          <p className="text-sm font-bold leading-relaxed">{message}</p>
          {subMessage && (
            <p className="text-xs font-bold opacity-80 leading-relaxed">{subMessage}</p>
          )}
        </div>
        <div className="flex gap-3">
          {!hideCancel && (
            <button
              onClick={onCancel}
              className="flex-1 py-3 bg-white/5 hover:bg-white/10 font-bold rounded-2xl text-sm transition-colors active:scale-95"
            >
              {cancelLabel}
            </button>
          )}
          <button
            onClick={onConfirm}
            className={`${hideCancel ? 'w-full' : 'flex-1'} py-3 font-bold rounded-2xl text-sm transition-all active:scale-95 text-white shadow-lg ${
              isDanger 
                ? 'bg-red-500 hover:bg-red-400 shadow-red-500/20' 
                : 'bg-accent-600 hover:bg-accent-500 shadow-accent-500/20'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
