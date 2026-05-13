'use client';

import React from 'react';

type ReaderTheme = {
  bg: string;
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
  <div className="fixed inset-0 z-[120] flex items-end" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={onClose}>
    <div className={`w-full ${theme.bg} rounded-t-2xl p-6`} onClick={event => event.stopPropagation()}>
      <h3 className="font-bold mb-3 text-sm">위치로 이동</h3>
      <p className="text-xs opacity-50 mb-4">퍼센트 (예: 42.5) 또는 CFI 값을 입력하세요</p>
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
    </div>
  </div>
);
