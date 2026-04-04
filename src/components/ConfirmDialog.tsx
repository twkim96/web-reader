// src/components/ConfirmDialog.tsx
import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  message: string;
  subMessage?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  theme: { bg: string; text: string; border: string };
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  message,
  subMessage,
  confirmLabel = '확인',
  cancelLabel = '취소',
  theme,
  onConfirm,
  onCancel,
}) => {
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
          <div className="p-3 rounded-2xl bg-red-500/10 text-red-400">
            <AlertTriangle size={22} />
          </div>
          <p className="text-sm font-bold leading-relaxed">{message}</p>
          {subMessage && (
            <p className="text-xs opacity-50 leading-relaxed">{subMessage}</p>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-3 bg-white/5 hover:bg-white/10 font-bold rounded-2xl text-sm transition-colors active:scale-95"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-3 font-bold rounded-2xl text-sm transition-all active:scale-95 bg-red-500 hover:bg-red-400 text-white shadow-lg shadow-red-500/20"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
