'use client';

import React from 'react';
import { Hash } from 'lucide-react';

type ReaderTheme = {
  bg: string;
  text: string;
  border: string;
};

interface ReaderStatusBarProps {
  theme: ReaderTheme;
  currentChapter: string;
  totalProgress: number;
  readingTime: string;
  onOpenJump: () => void;
}

export const ReaderStatusBar: React.FC<ReaderStatusBarProps> = ({
  theme,
  currentChapter,
  totalProgress,
  readingTime,
  onOpenJump,
}) => (
  <>
    <div className={`pointer-events-none fixed inset-x-0 bottom-0 z-[45] flex justify-center px-4 pb-[calc(env(safe-area-inset-bottom)+2px)] font-sans ${theme.text}`}>
      <div data-reader-status-main="true" className="flex max-w-[calc(100vw-2rem)] items-center gap-2 text-[11px] font-black tracking-widest">
        <span className="max-w-[42vw] truncate opacity-70">
          {currentChapter || 'Reading'}
        </span>
        <span className="text-accent-500">
          {(totalProgress || 0).toFixed(1)}%
        </span>
        <button
          type="button"
          onClick={onOpenJump}
          className="pointer-events-auto flex h-6 w-6 items-center justify-center opacity-45 transition-opacity hover:opacity-100"
          aria-label="위치로 이동"
          title="위치로 이동"
        >
          <Hash size={15} />
        </button>
      </div>
    </div>
    <span
      data-reader-book-reading-time="true"
      className={`pointer-events-none fixed bottom-0 right-2 z-[45] pb-[calc(env(safe-area-inset-bottom)+4px)] font-sans text-[10px] font-light tabular-nums opacity-30 ${theme.text}`}
    >
      {readingTime}
    </span>
  </>
);
