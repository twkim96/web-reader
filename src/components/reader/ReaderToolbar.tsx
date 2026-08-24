'use client';

import React from 'react';
import {
  BarChart3,
  Bookmark as BookmarkIcon,
  Info,
  List,
  Palette,
  Search,
  Settings,
  Volume2,
  X,
} from 'lucide-react';
import { getBookTitleFromFileName } from '../../lib/bookFormats';
import { getReaderProgressPercentFromPointer } from '../../lib/readerNavigation';
import { getReaderTitleLayout, type ReaderTitleLayout } from '../../lib/readerTitleLayout';
import type { ShelfDockStyle } from '../../types';

type ReaderTheme = {
  bg: string;
  text: string;
  border: string;
};

const READER_TEXT_MAX_INLINE_SIZE = 1000;
const READER_GAP_PERCENT = 5;
const READER_TEXT_EDGE_GAP_AT_MAX_RATIO = (
  READER_GAP_PERCENT / (2 * (100 - READER_GAP_PERCENT))
);

interface ReaderToolbarProps {
  theme: ReaderTheme;
  menuStyle: ShelfDockStyle;
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
  landscapeTwoPage?: boolean;
  onBack: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTheme: () => void;
  onOpenBookmarks: () => void;
  onOpenToc: () => void;
  onOpenTts: () => void;
  onOpenStatistics: () => void;
  onOpenBookInfo: () => void;
  onProgressSliderStart: () => void;
  onProgressSliderPreview: (progressPercent: number) => void;
  onProgressSliderCommit: () => void;
  onProgressSliderCancel: () => void;
}

const getSafePercent = (progress: number) => {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, progress));
};

const getReaderSurfaceStyle = (menuStyle: ShelfDockStyle): React.CSSProperties => (
  menuStyle === 'standard'
    ? {
      backdropFilter: 'blur(28px) saturate(1.32)',
      WebkitBackdropFilter: 'blur(28px) saturate(1.32)',
      backgroundColor: 'var(--viewer-reader-glass-surface, var(--viewer-reader-surface))',
      borderColor: 'var(--viewer-reader-glass-border, var(--viewer-theme-border))',
    }
    : menuStyle === 'modern'
      ? {
      // Preserve the pre-1.8.24 reader chrome as the Modern menu style.
      backdropFilter: 'blur(18px) saturate(1.18)',
      WebkitBackdropFilter: 'blur(18px) saturate(1.18)',
      backgroundColor: 'var(--viewer-reader-surface)',
      }
      : {}
);

const getReaderSurfaceClass = (menuStyle: ShelfDockStyle) => (
  menuStyle === 'glass' ? 'viewer-cime-glass' : ''
);

export const ReaderToolbar: React.FC<ReaderToolbarProps> = ({
  theme,
  menuStyle,
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
  landscapeTwoPage = false,
  onBack,
  onOpenSearch,
  onOpenSettings,
  onOpenTheme,
  onOpenBookmarks,
  onOpenToc,
  onOpenTts,
  onOpenStatistics,
  onOpenBookInfo,
  onProgressSliderStart,
  onProgressSliderPreview,
  onProgressSliderCommit,
  onProgressSliderCancel,
}) => {
  const safeSliderProgress = getSafePercent(sliderProgress || 0);
  const progressLabel = `${safeSliderProgress.toFixed(1)}%`;
  const title = getBookTitleFromFileName(bookName);
  const surfaceStyle = getReaderSurfaceStyle(menuStyle);
  const surfaceClass = getReaderSurfaceClass(menuStyle);
  const hasReaderRecords = bookmarkCount > 0 || annotationCount > 0;
  const [isLandscape, setIsLandscape] = React.useState(false);
  const readerTextMaxInlineSize = landscapeTwoPage && isLandscape
    ? READER_TEXT_MAX_INLINE_SIZE * 2
    : READER_TEXT_MAX_INLINE_SIZE;
  const readerTextEdgeGapAtMaxWidth = (
    readerTextMaxInlineSize * READER_TEXT_EDGE_GAP_AT_MAX_RATIO
  );
  const menuPositionStyle: React.CSSProperties = {
    right: isFixedLayout
      ? 'calc(env(safe-area-inset-right) + 1rem)'
      : `max(calc(env(safe-area-inset-right) + 1rem), ${READER_GAP_PERCENT}vw, calc((100vw - ${readerTextMaxInlineSize}px) / 2 + ${readerTextEdgeGapAtMaxWidth}px))`,
  };
  const titleRightLimitRef = React.useRef<HTMLButtonElement>(null);
  const titleMeasureRef = React.useRef<HTMLDivElement>(null);
  const activeProgressPointerIdRef = React.useRef<number | null>(null);
  const [titleLayout, setTitleLayout] = React.useState<ReaderTitleLayout>('center');

  const previewProgressPointer = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const progressPercent = getReaderProgressPercentFromPointer(
      event.clientX,
      rect.left,
      rect.width,
    );
    if (progressPercent === null) return false;
    onProgressSliderPreview(progressPercent);
    return true;
  }, [onProgressSliderPreview]);

  const handleProgressPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    event.preventDefault();
    activeProgressPointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    previewProgressPointer(event);
  }, [previewProgressPointer]);

  const handleProgressPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activeProgressPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    previewProgressPointer(event);
  }, [previewProgressPointer]);

  const finishProgressPointer = React.useCallback((event: React.PointerEvent<HTMLDivElement>, updateFinalPosition: boolean) => {
    if (activeProgressPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    if (updateFinalPosition) previewProgressPointer(event);
    activeProgressPointerIdRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    onProgressSliderCommit();
  }, [onProgressSliderCommit, previewProgressPointer]);

  const cancelProgressPointer = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (activeProgressPointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    activeProgressPointerIdRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    onProgressSliderCancel();
  }, [onProgressSliderCancel]);

  const updateTitleLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const titleRightLimit = titleRightLimitRef.current;
    const titleMeasure = titleMeasureRef.current;
    if (!titleRightLimit || !titleMeasure) return;

    const viewportWidth = window.innerWidth;
    const leftInset = window.matchMedia('(min-width: 640px)').matches ? 16 : 12;
    const rightLimit = titleRightLimit.getBoundingClientRect().left - 6;
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
  }, [isFixedLayout, isLandscape, landscapeTwoPage, menuStyle, title, updateTitleLayout]);

  React.useEffect(() => {
    window.addEventListener('resize', updateTitleLayout);
    void document.fonts?.ready.then(updateTitleLayout);
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(updateTitleLayout);
    if (titleRightLimitRef.current) observer?.observe(titleRightLimitRef.current);
    if (titleMeasureRef.current) observer?.observe(titleMeasureRef.current);
    return () => {
      window.removeEventListener('resize', updateTitleLayout);
      observer?.disconnect();
    };
  }, [updateTitleLayout]);

  React.useLayoutEffect(() => {
    const landscapeQuery = window.matchMedia('(orientation: landscape)');
    const updateLandscape = () => setIsLandscape(landscapeQuery.matches);
    updateLandscape();
    landscapeQuery.addEventListener('change', updateLandscape);
    return () => landscapeQuery.removeEventListener('change', updateLandscape);
  }, []);

  const usesRightTitleLayout = titleLayout === 'right';

  return (
    <>
      <nav data-reader-menu-style={menuStyle} className={`app-radius-exempt fixed inset-x-0 top-0 z-50 px-3 pt-[calc(env(safe-area-inset-top)+12px)] transition-transform duration-200 ease-out sm:px-4 sm:pt-[calc(env(safe-area-inset-top)+16px)] ${showControls ? 'pointer-events-none translate-y-0' : 'pointer-events-none -translate-y-[calc(100%+2rem)]'}`}>
        <button
          ref={titleRightLimitRef}
          type="button"
          onClick={onBack}
          aria-label="Close reader"
          data-reader-close-button="true"
          data-reader-title-right-limit="true"
          className={`pointer-events-auto absolute top-[calc(env(safe-area-inset-top)+11px)] flex h-11 w-11 items-center justify-center rounded-full border ${theme.border} ${surfaceClass} shadow-[0_10px_28px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 sm:top-[calc(env(safe-area-inset-top)+15px)]`}
          style={{ ...surfaceStyle, right: menuPositionStyle.right }}
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
        <div
          className={`flex min-w-0 ${usesRightTitleLayout ? 'justify-end pl-2 sm:pl-3' : 'justify-center px-3'}`}
          style={usesRightTitleLayout
            ? { paddingRight: `calc(${String(menuPositionStyle.right)} + 3.875rem)` }
            : undefined}
        >
          <div
            data-reader-title-surface="true"
            className={`pointer-events-auto relative rounded-2xl border ${theme.border} ${surfaceClass} px-[1.125rem] py-[0.65rem] shadow-[0_10px_30px_rgba(0,0,0,0.18)] sm:px-5 ${usesRightTitleLayout ? 'w-fit max-w-full' : 'w-max max-w-none'}`}
            style={surfaceStyle}
          >
            <h2 className={`text-center text-[15px] font-bold leading-snug ${usesRightTitleLayout ? 'break-words' : 'whitespace-nowrap'}`}>
              {title}
            </h2>
          </div>
        </div>
      </nav>

      <div
        data-reader-toolbar-menu="true"
        data-reader-menu-style={menuStyle}
        className={`app-radius-exempt fixed bottom-[calc(env(safe-area-inset-bottom)+3.25rem)] z-50 w-[min(17.1875rem,calc(100vw_-_2rem))] origin-bottom-right font-sans transition-transform duration-200 ease-out md:bottom-[calc(env(safe-area-inset-bottom)+3.75rem)] md:w-[min(18.90625rem,calc(100vw_-_2rem))] ${showControls ? 'pointer-events-auto visible translate-y-0 scale-100' : 'pointer-events-none invisible translate-y-3 scale-[0.98]'}`}
        style={menuPositionStyle}
      >
        <div className="relative grid gap-y-[0.34375rem] md:gap-y-[0.378125rem]">
          {isSliderPreviewing && (
            <div
              className={`relative mx-auto grid max-h-[4.5rem] w-[min(17rem,100%)] content-center overflow-hidden rounded-[1.25rem] border ${theme.border} ${surfaceClass} px-4 py-1.5 text-center shadow-[0_14px_32px_rgba(0,0,0,0.22)] transition-transform duration-150`}
              style={surfaceStyle}
            >
              {sliderPreviewChapter && (
                <div className="overflow-hidden text-[13px] font-medium leading-tight [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] md:text-[14.3px]">
                  {sliderPreviewChapter}
                </div>
              )}
              <div className="text-[10.5px] font-medium text-accent-500 md:text-[11.55px]">
                {progressLabel}
              </div>
            </div>
          )}

          <div
            data-reader-toolbar-utilities="true"
            className="absolute bottom-[calc(100%+0.34375rem)] right-0 flex items-center gap-1.5 md:bottom-[calc(100%+0.378125rem)] md:gap-[0.4125rem]"
          >
            {!isFixedLayout && (
              <button
                type="button"
                onClick={onOpenTts}
                disabled={!ttsSupported}
                className={`relative flex size-11 items-center justify-center rounded-full border ${theme.border} ${surfaceClass} shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 disabled:opacity-35 md:size-[3.025rem] ${ttsActive ? 'text-accent-500' : ''}`}
                style={surfaceStyle}
                aria-label={ttsSupported ? '현재 위치부터 듣기' : '이 브라우저는 TTS 미지원'}
                title={ttsSupported ? '현재 위치부터 듣기' : '이 브라우저는 TTS를 지원하지 않습니다'}
              >
                <Volume2 className="size-[19px] md:size-[21px]" />
              </button>
            )}
            <button
              type="button"
              onClick={onOpenStatistics}
              className={`relative flex size-11 items-center justify-center rounded-full border ${theme.border} ${surfaceClass} shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:size-[3.025rem]`}
              style={surfaceStyle}
              aria-label="독서 통계"
              title="독서 통계"
            >
              <BarChart3 className="size-[19px] md:size-[21px]" />
            </button>
            <button
              type="button"
              onClick={onOpenBookInfo}
              className={`relative flex size-11 items-center justify-center rounded-full border ${theme.border} ${surfaceClass} shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:size-[3.025rem]`}
              style={surfaceStyle}
              aria-label="도서 정보"
              title="도서 정보"
            >
              <Info className="size-[19px] md:size-[21px]" />
            </button>
          </div>

          <div
            className={`relative h-[2.8875rem] overflow-hidden rounded-full border ${theme.border} ${surfaceClass} shadow-[0_12px_30px_rgba(0,0,0,0.2)] focus-within:ring-2 focus-within:ring-accent-500/70 md:h-[3.17625rem]`}
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
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center px-[1.125rem] text-[15px] font-medium md:px-[1.2375rem] md:text-[16.5px]">
              <span>목차 · {progressLabel}</span>
            </div>
            <button
              type="button"
              onClick={onOpenToc}
              className="absolute inset-y-0 right-0 z-10 flex w-[2.8875rem] items-center justify-center transition-opacity hover:opacity-80 md:w-[3.17625rem]"
              aria-label="목차"
              title="목차"
            >
              <List className="size-[23px] md:size-[25px]" />
            </button>
            <div
              className="pointer-events-none absolute inset-y-0 right-[2.8875rem] w-px bg-current/10 md:right-[3.17625rem]"
            />
            <div
              data-reader-progress-pointer-track="true"
              aria-hidden="true"
              onPointerDown={handleProgressPointerDown}
              onPointerMove={handleProgressPointerMove}
              onPointerUp={(event) => finishProgressPointer(event, true)}
              onPointerCancel={cancelProgressPointer}
              onLostPointerCapture={cancelProgressPointer}
              onContextMenu={(event) => event.preventDefault()}
              className="absolute inset-y-0 left-0 right-[2.8875rem] z-[5] cursor-pointer touch-none select-none [-webkit-touch-callout:none] md:right-[3.17625rem]"
            />
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={safeSliderProgress}
              onKeyDown={onProgressSliderStart}
              onKeyUp={onProgressSliderCommit}
              onBlur={onProgressSliderCommit}
              onChange={(event) => onProgressSliderPreview(parseFloat(event.target.value))}
              className="pointer-events-none absolute inset-y-0 left-0 right-[2.8875rem] h-full opacity-0 md:right-[3.17625rem]"
              aria-label="진행률"
            />
          </div>

          {!isFixedLayout && (
            <button
              type="button"
              onClick={onOpenSearch}
              className={`relative flex h-[2.8875rem] items-center justify-between rounded-full border ${theme.border} ${surfaceClass} px-[1.125rem] text-[15px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.17625rem] md:px-[1.2375rem] md:text-[16.5px]`}
              style={surfaceStyle}
            >
              <span>책 검색</span>
              <Search className="size-6 md:size-[26px]" />
            </button>
          )}

          <div
            data-reader-toolbar-actions="true"
            className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 md:gap-[0.4125rem]"
          >
            <button
              type="button"
              onClick={onOpenBookmarks}
              className={`relative flex h-[2.8875rem] min-w-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border ${theme.border} ${surfaceClass} px-1 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.17625rem] md:gap-1 md:px-1 md:text-[13.2px] ${hasReaderRecords ? 'text-accent-500' : ''}`}
              style={surfaceStyle}
              aria-label="책갈피와 주석"
              aria-describedby="reader-record-counts"
              title={`책갈피 ${bookmarkCount}개 · 주석 ${annotationCount}개`}
            >
              <BookmarkIcon className="size-[19px] shrink-0 md:size-[21px]" />
              <span className="shrink-0">책갈피</span>
              {bookmarkCount > 0 && (
                <span className="shrink-0 text-[11px] font-bold tabular-nums md:text-[12px]">
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
              className={`relative flex h-[2.8875rem] items-center justify-center gap-1 rounded-full border ${theme.border} ${surfaceClass} px-1 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.17625rem] md:gap-1 md:px-1 md:text-[13.2px]`}
              style={surfaceStyle}
              aria-label="테마"
              title="테마"
            >
              <Palette className="size-[19px] md:size-[21px]" />
              <span>테마</span>
            </button>
            <button
              type="button"
              onClick={onOpenSettings}
              className={`relative flex h-[2.8875rem] items-center justify-center gap-1 rounded-full border ${theme.border} ${surfaceClass} px-1 text-[12px] font-medium shadow-[0_12px_30px_rgba(0,0,0,0.2)] transition-opacity hover:opacity-100 md:h-[3.17625rem] md:gap-1 md:px-1 md:text-[13.2px]`}
              style={surfaceStyle}
              aria-label="설정"
              title="설정"
            >
              <Settings className="size-[19px] md:size-[21px]" />
              <span>설정</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
