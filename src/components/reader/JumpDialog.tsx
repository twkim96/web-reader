'use client';

import React from 'react';
import { X } from 'lucide-react';
import { ReaderModalFrame } from './ReaderModalFrame';

type ReaderTheme = {
  bg: string;
  text?: string;
  border: string;
};

interface JumpDialogProps {
  theme: ReaderTheme;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export const JumpDialog: React.FC<JumpDialogProps> = ({
  theme,
  value,
  onChange,
  onSubmit,
  onClose,
}) => (
  <ReaderModalFrame ariaLabel="진행률 이동" theme={theme} onClose={onClose} maxWidth="max-w-md" className="p-6" zIndex="z-[120]">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-lg">위치로 이동</h3>
        <button onClick={onClose} aria-label="위치 이동 닫기" className="app-modal-close -mr-2 rounded-full p-2 transition-opacity hover:opacity-80">
          <X size={20} />
        </button>
      </div>
      <p className="text-xs opacity-50 mb-5">퍼센트 (예: 42.5) 또는 CFI 값을 입력하세요</p>
      <div className="flex gap-3">
        <input
          autoFocus
          type="text"
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') onSubmit();
            if (event.key === 'Escape') onClose();
          }}
          placeholder="예: 42.5 또는 epubcfi(...)"
          className={`flex-1 px-4 py-3 rounded-xl text-sm border ${theme.border} bg-transparent outline-none focus:ring-2 focus:ring-accent-500`}
        />
        <button onClick={onSubmit} className="px-5 py-3 rounded-xl bg-accent-500 text-white font-bold text-sm hover:bg-accent-600 transition-colors">
          이동
        </button>
      </div>
  </ReaderModalFrame>
);
