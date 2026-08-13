'use client';

import React from 'react';
import {
  BarChart3,
  Bookmark as BookmarkIcon,
  List,
  Palette,
  Search,
  Settings,
  Volume2,
  X,
} from 'lucide-react';
import { getBookTitleFromFileName } from '../../lib/bookFormats';
import { getReaderTitleLayout, type ReaderTitleLayout } from '../../lib/readerTitleLayout';

type ReaderTheme = {
  bg: string;
  text: string;
  border: string;
};

const READER_TEXT_MAX_INLINE_SIZE = 1000;
const READER_MENU_DOUBLE_WIDTH = '37.5rem';

interface ReaderToolbarProps {
  theme: ReaderTheme;
  bookName: string;
  showControls: boolean;
  sliderProgress: number;
  isSliderPreviewing: boolean;
  sliderPreviewChapter?: string;
  bookmarkCount: number;
  annotationCount: number;
  ttsSupported?: boolean;
  ttsActive?: boolean;
  isFixedLayout?: boolean;
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTheme: () => void;
  onOpenBookmarks: () => void;
  onOpenToc: () => void;
  onOpenTts: () => void;
  onOpenStatistics: () => void;
  onProgressSliderStart: () => void;
  onProgressSliderPreview: (progressPercent: number) => void;
  onProgressSliderCommit: () => void;
}

const getSafePercent = (progress: number) => {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
};

const getReaderSurfaceStyle = (): React.CSSProperties => ({
  backdropFilter: 'blur(18px) saturate(1.18)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.18)',
  backgroundColor: 'var(--viewer-reader-surface)',
});

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  theme,
  bookName,
  showControls,
  sliderProgress,
  isSliderPreviewing,
  sliderPreviewChapter,
  bookmarkCount,
  annotationCount,
  ttsSupported = false,
  ttsActive = false,
  isFixedLayout = false,
  onBack,
  onOpenSearch,
  onOpenSettings,
  onOpenTheme,
  onOpenBookmarks,
  onOpenToc,
  onOpenTts,
  onOpenStatistics,
  onProgressSliderStart,
  onProgressSliderPreview,
  onProgressSliderCommit,
}) => {
  const safeSliderProgress = getSafePercent(sliderProgress || 0);
  const progressLabel = `${safeSliderProgress.toFixed(1)}%`;
  const title = getBookTitleFromFileName(bookName);
  const surfaceStyle = getReaderSurfaceStyle();
  const hasReaderRecords = bookmarkCount > 0 || annotationCount > 0;
  const menuPositionStyle: React.CSSProperties = {
    right: `max(calc(env(safe-area-inset-right) + 1rem), calc((100vw - (${READER_TEXT_MAX_INLINE_SIZE}px + ${READER_MENU_DOUBLE_WIDTH})) / 2))`,
  };
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  const titleMeasureRef = React.useRef<HTMLDivElement>(null);
  const [titleLayout, setTitleLayout] = React.useState<ReaderTitleLayout>('center');

  const updateTitleLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const closeButton = closeButtonRef.current;
    const titleMeasure = titleMeasureRef.current;
    if (!closeButton || !titleMeasure) return;

    const viewportWidth = window.innerWidth;
    const leftInset = window.matchMedia('(min-width: 640px)').matches ? 16 : 12;
    const rightLimit = closeButton.getBoundingClientRect().left - 6;
    const titleWidth = titleMeasure.getBoundingClientRect().width;
    const nextLayout = getReaderTitleLayout({
      viewportWidth,
      leftInset,
      rightLimit,
      titleWidth,
    });

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

  const usesRightTitleLayout = titleLayout === 'right';

  return (
    <>
      <nav className={`fixed inset-x-0 top-0 z-50 px-3 pt-[calc(env(safe-area-inset-top)+12px)] transition-transform duration-200 ease-out sm:px-4 sm:pt-[calc(env(safe-area-inset-top)+16px)] ${showControls ? 'pointer-events-none translate-y-0' : 'pointer-events-none -translate-y-[calc(100%+2rem)]'}`}>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onBack}
          aria-label="Close reader"
          className={`pointer-events-auto absolute right-[calc(env(safe-area-inset-right)+12px)] top-[calc(env(safe-area-inset-top)+11px)] flex h-11 w-11 items-center justify-center rounded-full border ${theme.border} shadow-[0_10px_28px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100`}
          style={surfaceStyle}
        >
          <X size={22} />
        </button>
        <div
          ref={titleMeasureRef}
          aria-hidden="true"
          className="pointer-events-none invisible fixed left-0 top-0 -z-10 w-max rounded-2xl border border-transparent px-[1.125rem] py-[0.65rem] sm:px-5"
        >
          <span className="whitespace-nowrap text-[15px] font-bold leading-snug">
            {title}
          </span>
        </div>
        <div className={`flex min-w-0 ${usesRightTitleLayout ? 'justify-end pl-2 pr-[calc(env(safe-area-inset-right)+3.875rem)] sm:pl-3 sm:pr-[calc(env(safe-area-inset-right)+3.875rem)]' : 'justify-center px-3'}`}>
          <div
            className={`pointer-events-auto rounded-2xl border ${theme.border} px-[1.125rem] py-[0.65rem] shadow-[0_10px_30px_rgba(0,0,0,0.18)] sm:px-5 ${usesRightTitleLayout ? 'w-fit max-w-full' : 'w-max max-w-none'}`}
            style={surfaceStyle}
          >
            <h2 className={`text-center text-[15px] font-bold leading-snug ${usesRightTitleLayout ? 'break-words' : 'whitespace-nowrap'}`}>
              {title}
            </h2>
          </div>
        </div>
      </nav>

      <div
        className={`fixed bottom-[calc(env(safe-area-inset-bottom)+3.25rem)] z-50 w-[min(15.625rem,calc(100vw_-_2rem))] origin-bottom-right font-sans transition-transform duration-200 ease-out md:bottom-[calc(env(safe-area-inset-bottom)+3.75rem)] md:w-[min(19.53125rem,calc(100vw_-_2rem))] ${showControls ? 'pointer-events-auto visible translate-y-0 scale-100' : 'pointer-events-none invisible translate-y-3 scale-[0.98]'}`}
        style={menuPositionStyle}
      >
        <div className="relative grid gap-y-1.5">
          {isSliderPreviewing && (
            <div
              className={`mx-auto grid max-h-[4.5rem] w-[min(17rem,100%)] content-center overflow-hidden rounded-[1.25rem] border ${theme.border} px-4 py-1.5 text-center shadow-[0_14px_32px_rgba(0,0,0,0.22)] transition-transform duration-150`}
              style={surfaceStyle}
            >
              {sliderPreviewChapter && (
                <div className="overflow-hidden text-[13px] font-bold leading-tight [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                  {sliderPreviewChapter}
                </div>
              )}
              <div className="text-[10.5px] font-bold text-accent-500">
                {progressLabel}
              </div>
            </div>
          )}

          <div
            data-reader-toolbar-utilities="true"
            className="absolute bottom-[calc(100%+0.375rem)] right-0 flex items-center gap-1.5 md:gap-2"
          >
            {!isFixedLayout && (
              <button
                type="button"
                onClick={onOpenTts}
                disabled={!ttsSupported}
                className={`flex size-11 items-center justify-center rounded-full border ${theme.border} shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 disabled:opacity-35 md:size-[3.4375rem] ${ttsActive ? 'text-accent-500' : ''}`}
                style={surfaceStyle}
                aria-label={ttsSupported ? '현재 위치부터 듣기' : '이 브라우저는 TTS 미지원'}
                title={ttsSupported ? '현재 위치부터 듣기' : '이 브라우저는 TTS를 지원하지 않습니다'}
              >
                <Volume2 className="size-[19px] md:size-6" />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenStatistics}
              className={`flex size-11 items-center justify-center rounded-full border ${theme.border} shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:size-[3.4375rem]`}
              style={surfaceStyle}
              aria-label="독서 통계"
              title="독서 통계"
            >
              <BarChart3 className="size-[19px] md:size-6" />
            </button>
          </div>

          <div
            className={`relative h-[3.15rem] overflow-hidden rounded-full border ${theme.border} shadow-[0_12px_30px_rgba(0,0,0,0.2)] md:h-[3.9375rem]`}
            style={surfaceStyle}
          >
            <div
              className="pointer-events-none absolute inset-y-0 left-0 bg-current/20"
              style={{ width: `${safeSliderProgress}%` }}
            />
            <div
              className="pointer-events-none absolute top-1/2 h-7 w-px -translate-y-1/2 rounded-full bg-current/45"
              style={{ left: `${safeSliderProgress}%` }}
            />
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center px-[1.125rem] text-[15px] font-bold md:px-[1.40625rem] md:text-[19px]">
              <span>목차 · {progressLabel}</span>
            </div>
            <button
              type="button"
              onClick={onOpenToc}
              className="absolute inset-y-0 right-0 z-10 flex w-[3.15rem] items-center justify-center transition-opacity hover:opacity-80 md:w-[3.9375rem]"
              aria-label="목차"
              title="목차"
            >
              <List className="size-[23px] md:size-[29px]" />
            </button>
            <div
              className="pointer-events-none absolute inset-y-0 right-[3.15rem] w-px bg-current/10 md:right-[3.9375rem]"
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
              className="absolute inset-y-0 left-0 right-[3.15rem] h-full cursor-pointer opacity-0 md:right-[3.9375rem]"
              aria-label="진행률"
            />
          </div>

          {!isFixedLayout && (
            <button
              type="button"
              onClick={onOpenSearch}
              className={`flex h-[3.15rem] items-center justify-between rounded-full border ${theme.border} px-[1.125rem] text-[15px] font-bold shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.9375rem] md:px-[1.40625rem] md:text-[19px]`}
              style={surfaceStyle}
            >
              <span>책 검색</span>
              <Search className="size-6 md:size-[30px]" />
            </button>
          )}

          <div
            data-reader-toolbar-actions="true"
            className="grid grid-cols-3 gap-1.5 md:gap-2"
          >
            <button
              type="button"
              onClick={onOpenBookmarks}
              className={`flex h-[3.15rem] min-w-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border ${theme.border} px-1 text-[12px] font-bold shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.9375rem] md:gap-1.5 md:px-1.5 md:text-[15px] ${hasReaderRecords ? 'text-accent-500' : ''}`}
              style={surfaceStyle}
              aria-label="책갈피와 주석"
              aria-describedby="reader-record-counts"
              title={`책갈피 ${bookmarkCount}개 · 주석 ${annotationCount}개`}
            >
              <BookmarkIcon className="size-[19px] shrink-0 md:size-6" />
              <span className="shrink-0">책갈피</span>
              {bookmarkCount > 0 && (
                <span className="shrink-0 text-[11px] font-black tabular-nums md:text-[14px]">
                  {bookmarkCount}
                </span>
              )}
              {annotationCount > 0 && (
                <span
                  data-reader-annotation-indicator="true"
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full bg-current"
                />
              )}
              <span id="reader-record-counts" className="sr-only">
                책갈피 {bookmarkCount}개, 주석 {annotationCount}개
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenTheme}
              className={`flex h-[3.15rem] items-center justify-center gap-1 rounded-full border ${theme.border} px-1 text-[12px] font-bold shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.9375rem] md:gap-1.5 md:px-1.5 md:text-[15px]`}
              style={surfaceStyle}
              aria-label="테마"
              title="테마"
            >
              <Palette className="size-[19px] md:size-6" />
              <span>테마</span>
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className={`flex h-[3.15rem] items-center justify-center gap-1 rounded-full border ${theme.border} px-1 text-[12px] font-bold shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.9375rem] md:gap-1.5 md:px-1.5 md:text-[15px]`}
              style={surfaceStyle}
              aria-label="설정"
              title="설정"
            >
              <Settings className="size-[19px] md:size-6" />
              <span>설정</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
