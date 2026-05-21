'use client';

import React from 'react';
import { Bookmark as BookmarkIcon, ChevronLeft, Hash, List, Palette, Search, Settings } from 'lucide-react';

type ReaderTheme = {
  bg: string;
  text: string;
  border: string;
};

interface ReaderToolbarProps {
  theme: ReaderTheme;
  bookName: string;
  showControls: boolean;
  currentChapter: string;
  totalProgress: number;
  sliderProgress: number;
  bookmarkCount: number;
  onBack: () => void;
  onOpenJump: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTheme: () => void;
  onOpenBookmarks: () => void;
  onOpenToc: () => void;
  onProgressSliderStart: () => void;
  onProgressSliderPreview: (progressPercent: number) => void;
  onProgressSliderCommit: () => void;
}

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  theme,
  bookName,
  showControls,
  currentChapter,
  totalProgress,
  sliderProgress,
  bookmarkCount,
  onBack,
  onOpenJump,
  onOpenSearch,
  onOpenSettings,
  onOpenTheme,
  onOpenBookmarks,
  onOpenToc,
  onProgressSliderStart,
  onProgressSliderPreview,
  onProgressSliderCommit,
}) => (
  <>
    <nav className={`pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-[calc(env(safe-area-inset-top)+12px)] transition-transform duration-300 sm:px-4 sm:pt-[calc(env(safe-area-inset-top)+16px)] ${showControls ? 'translate-y-0' : '-translate-y-[calc(100%+2rem)]'}`}>
      <button
        onClick={onBack}
        aria-label="Back"
        className={`pointer-events-auto absolute left-3 top-[calc(env(safe-area-inset-top)+14px)] flex h-10 w-10 items-center justify-center rounded-full border ${theme.bg}/80 ${theme.border} shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100 sm:left-4 sm:top-[calc(env(safe-area-inset-top)+18px)]`}
      >
        <ChevronLeft size={22} />
      </button>
      <div className="flex justify-start pl-13 sm:justify-center sm:pl-0">
        <div className={`pointer-events-auto w-fit max-w-[calc(100%_-_3.25rem)] rounded-xl border ${theme.bg}/80 ${theme.border} px-6 py-2.5 shadow-[0_10px_30px_rgba(0,0,0,0.16)] backdrop-blur-md sm:max-w-[min(36rem,calc(100%_-_8.5rem))] sm:px-8`}>
          <h2 className="text-center text-sm font-bold leading-tight break-words [overflow-wrap:anywhere]">
            {bookName.replace('.epub', '').replace('.txt', '')}
          </h2>
        </div>
      </div>
    </nav>

    <div className={`pointer-events-none fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] transition-transform duration-300 sm:px-4 sm:pb-[calc(env(safe-area-inset-bottom)+16px)] ${showControls ? 'translate-y-0' : 'translate-y-[calc(100%+2rem)]'}`}>
      <div className={`pointer-events-auto mx-auto max-w-xl overflow-hidden rounded-xl border ${theme.bg}/80 ${theme.border} shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-md`}>
        <div className="px-6 pt-4 pb-0">
          <div className="flex items-center justify-center mb-3 gap-2">
            <span className="text-[11px] font-black tracking-widest font-sans opacity-100 truncate max-w-[85%] text-center">
              {currentChapter || 'Reading'}
              <span className="ml-3 text-accent-500">{(totalProgress || 0).toFixed(1)}%</span>
            </span>
            <button onClick={onOpenJump} className="opacity-40 hover:opacity-100 transition-opacity p-1 shrink-0">
              <Hash size={16} />
            </button>
          </div>

          <div className="flex items-center gap-4">
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={sliderProgress || 0}
              onPointerDown={onProgressSliderStart}
              onPointerUp={onProgressSliderCommit}
              onKeyDown={onProgressSliderStart}
              onKeyUp={onProgressSliderCommit}
              onBlur={onProgressSliderCommit}
              onChange={(event) => onProgressSliderPreview(parseFloat(event.target.value))}
              className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-accent-500"
            />
            <button onClick={onOpenSearch} className="p-2 -mr-2 opacity-60 hover:opacity-100 transition-opacity shrink-0">
              <Search size={22} />
            </button>
          </div>
        </div>

        <div className="mx-4 mt-3 border-t border-current/10" />

        <div className="flex justify-around px-5 pt-3 pb-4 font-sans">
          <button onClick={onOpenSettings} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button onClick={onOpenTheme} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Palette size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Theme</span>
          </button>
          <button
            onClick={onOpenBookmarks}
            className={`flex flex-col items-center gap-1.5 transition-opacity ${bookmarkCount > 0 ? 'text-accent-500 opacity-100' : 'opacity-60 hover:opacity-100'}`}
          >
            <BookmarkIcon size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">
              Mark{bookmarkCount > 0 ? ` (${bookmarkCount})` : ''}
            </span>
          </button>
          <button onClick={onOpenToc} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <List size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Index</span>
          </button>
        </div>
      </div>
    </div>
  </>
);
