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
    <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
      <button onClick={onBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
      <h2 className="font-bold text-sm truncate px-4">{bookName.replace('.epub', '').replace('.txt', '')}</h2>
      <div className="w-10" />
    </nav>

    <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
      <div className="max-w-lg mx-auto px-6 pt-4 pb-0">
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

      <div className="flex justify-around px-5 pt-3 pb-4 max-w-lg mx-auto font-sans">
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
  </>
);
