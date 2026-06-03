'use client';

import React from 'react';
import {
  Bookmark as BookmarkIcon,
  List,
  Palette,
  Search,
  Settings,
  X,
} from 'lucide-react';

type ReaderTheme = {
  bg: string;
  text: string;
  border: string;
};

interface ReaderToolbarProps {
  theme: ReaderTheme;
  bookName: string;
  showControls: boolean;
  sliderProgress: number;
  isSliderPreviewing: boolean;
  sliderPreviewChapter?: string;
  bookmarkCount: number;
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTheme: () => void;
  onOpenBookmarks: () => void;
  onOpenToc: () => void;
  onProgressSliderStart: () => void;
  onProgressSliderPreview: (progressPercent: number) => void;
  onProgressSliderCommit: () => void;
}

const getBookTitle = (bookName: string) => bookName.replace('.epub', '').replace('.txt', '');

const getSafePercent = (progress: number) => {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
};

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  theme,
  bookName,
  showControls,
  sliderProgress,
  isSliderPreviewing,
  sliderPreviewChapter,
  bookmarkCount,
  onBack,
  onOpenSearch,
  onOpenSettings,
  onOpenTheme,
  onOpenBookmarks,
  onOpenToc,
  onProgressSliderStart,
  onProgressSliderPreview,
  onProgressSliderCommit,
}) => {
  const safeSliderProgress = getSafePercent(sliderProgress || 0);
  const progressLabel = `${safeSliderProgress.toFixed(1)}%`;
  const title = getBookTitle(bookName);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const titleMeasureRef = React.useRef<HTMLDivElement>(null);
  const [titleLayout, setTitleLayout] = React.useState<'center' | 'wide'>('center');

  const updateTitleLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const closeButton = closeButtonRef.current;
    const titleMeasure = titleMeasureRef.current;
    if (!closeButton || !titleMeasure) return;

    const viewportWidth = window.innerWidth;
    const leftInset = window.matchMedia('(min-width: 640px)').matches ? 16 : 12;
    const rightLimit = closeButton.getBoundingClientRect().left - 12;
    const titleWidth = titleMeasure.getBoundingClientRect().width;
    const centeredLeft = (viewportWidth - titleWidth) / 2;
    const centeredRight = (viewportWidth + titleWidth) / 2;
    const nextLayout = centeredLeft < leftInset || centeredRight > rightLimit ? 'wide' : 'center';

    setTitleLayout((currentLayout) => currentLayout === nextLayout ? currentLayout : nextLayout);
  }, []);

  React.useLayoutEffect(() => {
    const frameId = window.requestAnimationFrame(updateTitleLayout);
    return () => window.cancelAnimationFrame(frameId);
  }, [title, updateTitleLayout]);

  React.useEffect(() => {
    window.addEventListener('resize', updateTitleLayout);
    void document.fonts?.ready.then(updateTitleLayout);
    return () => window.removeEventListener('resize', updateTitleLayout);
  }, [updateTitleLayout]);

  const usesWideTitleLayout = titleLayout === 'wide';

  return (
    <>
      <nav className={`fixed inset-x-0 top-0 z-50 px-3 pt-[calc(env(safe-area-inset-top)+12px)] transition-transform duration-300 sm:px-4 sm:pt-[calc(env(safe-area-inset-top)+16px)] ${showControls ? 'pointer-events-none translate-y-0' : 'pointer-events-none -translate-y-[calc(100%+2rem)]'}`}>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onBack}
          aria-label="Close reader"
          className={`pointer-events-auto absolute right-[calc(env(safe-area-inset-right)+12px)] top-[calc(env(safe-area-inset-top)+10px)] flex h-12 w-12 items-center justify-center rounded-full border ${theme.bg} ${theme.border} shadow-[0_10px_28px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100`}
        >
          <X size={24} />
        </button>
        <div
          ref={titleMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible fixed left-0 top-0 -z-10 w-max rounded-2xl border border-transparent px-5 py-3 sm:px-6"
        >
          <span className="whitespace-nowrap text-base font-bold leading-snug">
            {title}
          </span>
        </div>
        <div className={`flex ${usesWideTitleLayout ? 'justify-start pl-3 pr-[calc(env(safe-area-inset-right)+5rem)] sm:pl-4 sm:pr-[calc(env(safe-area-inset-right)+5.5rem)]' : 'justify-center px-3'}`}>
          <div className={`pointer-events-auto w-fit rounded-2xl border ${theme.bg} ${theme.border} px-5 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.16)] backdrop-blur-md sm:px-6 ${usesWideTitleLayout ? 'max-w-full' : 'max-w-[min(40rem,calc(100vw_-_9rem))] sm:max-w-[min(40rem,calc(100vw_-_9.5rem))]'}`}>
            <h2 className="text-center text-base font-bold leading-snug break-words">
              {title}
            </h2>
          </div>
        </div>
      </nav>

      <div className={`fixed bottom-[calc(env(safe-area-inset-bottom)+3.25rem)] right-[calc(env(safe-area-inset-right)+1rem)] z-50 w-[min(20.5rem,calc(100vw_-_2rem))] font-sans transition-all duration-300 sm:right-[calc(env(safe-area-inset-right)+1.5rem)] sm:bottom-[calc(env(safe-area-inset-bottom)+3.75rem)] ${showControls ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-4 opacity-0'}`}>
        <div className="grid gap-y-2">
          {isSliderPreviewing && (
            <div className={`mx-auto max-w-full rounded-full border ${theme.bg} ${theme.border} px-5 py-2 text-center shadow-[0_14px_32px_rgba(0,0,0,0.2)] backdrop-blur-md transition-transform duration-150`}>
              {sliderPreviewChapter && (
                <div className="truncate text-sm font-bold leading-tight">
                  {sliderPreviewChapter}
                </div>
              )}
              <div className="text-[11px] font-bold text-accent-500">
                {progressLabel}
              </div>
            </div>
          )}

          <div className={`relative h-14 overflow-hidden rounded-full border ${theme.bg} ${theme.border} shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur-md`}>
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-current/20"
              style={{ width: `${safeSliderProgress}%` }}
            />
            <div
              className="pointer-events-none absolute top-1/2 h-8 w-px -translate-y-1/2 rounded-full bg-current/45"
              style={{ left: `${safeSliderProgress}%` }}
            />
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center px-5 text-base font-bold">
              <span>목차 · {progressLabel}</span>
            </div>
            <button
              type="button"
              onClick={onOpenToc}
              className="absolute inset-y-0 right-0 z-10 flex w-14 items-center justify-center transition-opacity hover:opacity-80"
              aria-label="목차"
              title="목차"
            >
              <List size={26} />
            </button>
            <div
              className="pointer-events-none absolute inset-y-0 right-14 w-px bg-current/10"
            />
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={safeSliderProgress}
              onPointerDown={onProgressSliderStart}
              onPointerUp={onProgressSliderCommit}
              onPointerCancel={onProgressSliderCommit}
              onKeyDown={onProgressSliderStart}
              onKeyUp={onProgressSliderCommit}
              onBlur={onProgressSliderCommit}
              onChange={(event) => onProgressSliderPreview(parseFloat(event.target.value))}
              className="absolute inset-y-0 left-0 right-14 h-full cursor-pointer opacity-0"
              aria-label="진행률"
            />
          </div>

          <button
            type="button"
            onClick={onOpenSearch}
            className={`flex h-14 items-center justify-between rounded-full border ${theme.bg} ${theme.border} px-5 text-base font-bold shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100`}
          >
            <span>책 검색</span>
            <Search size={27} />
          </button>

          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={onOpenSettings}
              className={`flex h-14 items-center justify-center gap-1 rounded-full border ${theme.bg} ${theme.border} px-2 text-sm font-bold shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100`}
            >
              <Settings size={21} />
              <span>설정</span>
            </button>
            <button
              type="button"
              onClick={onOpenTheme}
              className={`flex h-14 items-center justify-center gap-1 rounded-full border ${theme.bg} ${theme.border} px-2 text-sm font-bold shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100`}
              aria-label="테마"
              title="테마"
            >
              <Palette size={21} />
              <span>테마</span>
            </button>
            <button
              type="button"
              onClick={onOpenBookmarks}
              className={`flex h-14 items-center justify-center gap-1 rounded-full border ${theme.bg} ${theme.border} px-2 text-sm font-bold shadow-[0_12px_30px_rgba(0,0,0,0.18)] backdrop-blur-md transition-opacity hover:opacity-100 ${bookmarkCount > 0 ? 'text-accent-500' : ''}`}
              aria-label="북마크"
              title="북마크"
            >
              <BookmarkIcon size={21} />
              <span>북마크</span>
              {bookmarkCount > 0 && (
                <span className="text-xs font-black">
                  {bookmarkCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
