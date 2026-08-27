'use client';

import React from 'react';
import { MenuSheetHeader } from '../MenuSheetHeader';
import { ReaderModalFrame } from './ReaderModalFrame';

type ReaderTheme = {
  bg: string;
  text?: string;
  border: string;
  secondary?: string;
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
  <ReaderModalFrame
    ariaLabel="진행률 이동"
    menuSheet
    theme={theme}
    onClose={onClose}
    maxWidth="max-w-md"
    className="flex flex-col"
    zIndex="z-[120]"
  >
    <MenuSheetHeader
      kind="jump"
      title="위치로 이동"
      onClose={onClose}
      closeLabel="위치 이동 닫기"
      borderClass={theme.border}
      secondaryClass={theme.secondary}
    />
    <div data-reader-jump-dialog="true" className="app-menu-sheet-content px-4 py-5 sm:px-5">
      <p className="mb-5 text-xs opacity-50">퍼센트 (예: 42.5) 또는 CFI 값을 입력하세요</p>
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
        <button type="button" onClick={onSubmit} className="px-5 py-3 rounded-xl bg-accent-500 text-white font-bold text-sm hover:bg-accent-600 transition-colors">
          이동
        </button>
      </div>
    </div>
  </ReaderModalFrame>
);
