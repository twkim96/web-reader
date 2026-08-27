import React from 'react';
import { TocItem } from '../hooks/foliate/types';
import { ThemeClasses } from '../types';
import { ReaderModalFrame } from './reader/ReaderModalFrame';
import { MenuSheetHeader } from './MenuSheetHeader';

interface TocModalProps {
  toc: TocItem[];
  theme: ThemeClasses;
  onClose: () => void;
  onJump: (href: string, progressPercent?: number) => void;
  currentChapter?: string;
}

export const TocModal: React.FC<TocModalProps> = ({ toc, theme, onClose, onJump, currentChapter }) => {
  // 목차 평탄화 (중첩된 챕터도 리스트에 표시)
  const flattenToc = (items: TocItem[]): TocItem[] => {
    return items.reduce<TocItem[]>((acc, item) => {
      acc.push(item);
      if (item.subitems && item.subitems.length > 0) {
        acc.push(...flattenToc(item.subitems));
      }
      return acc;
    }, []);
  };

  const allChapters = flattenToc(toc);

  return (
    <ReaderModalFrame ariaLabel="목차" menuSheet theme={theme} onClose={onClose} maxWidth="max-w-md" className="flex flex-col max-h-[min(30rem,72vh)] sm:max-h-[32rem]">
        <MenuSheetHeader kind="toc" title="목차" subtitle="Table of Contents" onClose={onClose} borderClass={theme.border} secondaryClass={theme.secondary} />

        {/* List */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1 custom-scrollbar">
          {allChapters.length === 0 ? (
            <div className="py-20 text-center opacity-30 text-xs font-bold uppercase tracking-widest">
              No Chapters Found
            </div>
          ) : (
            allChapters.map((item, idx) => (
              <button
                key={idx}
                onClick={() => onJump(item.href, item.progress)}
                className={`w-full flex items-center justify-between p-3 rounded-xl transition-all group ${currentChapter === item.label
                    ? 'bg-accent-500/10 text-accent-500'
                    : 'hover:bg-white/5'
                  }`}
              >
                <div className="flex items-center gap-4 min-w-0 flex-1">
                  <span className={`text-[10px] font-black w-5 text-accent-500 ${currentChapter === item.label ? 'opacity-100' : 'opacity-40'} group-hover:opacity-100 transition-opacity`}>
                    {(idx + 1).toString().padStart(2, '0')}
                  </span>
                  <span className={`text-sm font-bold truncate ${currentChapter === item.label ? 'text-accent-500' : 'opacity-80'}`}>
                    {item.label}
                  </span>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={`text-[10px] font-bold text-accent-500 ${currentChapter === item.label ? 'opacity-100' : 'opacity-30'} group-hover:opacity-100 transition-opacity`}>
                    {(item.progress || 0).toFixed(1)}%
                  </span>
                  {currentChapter === item.label && (
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-500 shadow-[0_0_8px_rgba(var(--accent-500-rgb),0.6)]" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>
    </ReaderModalFrame>
  );
};
