'use client';

import React from 'react';
import { ReaderModalFrame } from './ReaderModalFrame';

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
}

export const ProgressJumpConfirmDialog: React.FC<ProgressJumpConfirmDialogProps> = ({
  theme,
  targetPercent,
  targetChapter,
  onCancel,
  onConfirm,
}) => (
  <ReaderModalFrame theme={theme} onClose={onCancel} maxWidth="max-w-[19rem]" className="p-5 font-sans" zIndex="z-[130]" placement="center">
    <div className="space-y-4 text-center">
      <div>
        {targetChapter && (
          <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-55">
            {targetChapter}
          </p>
        )}
        <h3 className="mt-2 text-lg font-bold tracking-tight">
          {targetPercent.toFixed(1)}%로 이동할까요?
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-10 rounded-xl border border-current/10 px-4 text-sm font-bold opacity-70 transition-opacity hover:opacity-100"
        >
          취소
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="h-10 rounded-xl bg-accent-500 px-4 text-sm font-bold text-white transition-colors hover:bg-accent-600"
        >
          확인
        </button>
      </div>
    </div>
  </ReaderModalFrame>
);
