import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { Eraser } from 'lucide-react';
import { Book, UserProgress } from '../../types';
import {
  formatPublicBookCatalogMetric,
  type PublicBookCatalogBook,
} from '../../lib/publicBookCatalog';
import { getBookFormatLabel, getDisplayBookTitle, getProgressTime, ShelfTheme } from './bookUtils';
import { GeneratedBookCover } from './GeneratedBookCover';

interface BookCardProps {
  book: Book;
  progress?: UserProgress;
  isDownloaded: boolean;
  viewMode: 'grid' | 'list';
  theme: ShelfTheme;
  onOpen: (book: Book) => void;
  onDeleteProgress?: (bookId: string) => void;
  onRequestBookInfo?: (book: Book) => void;
  catalog?: PublicBookCatalogBook;
  coverUrl?: string;
}

interface FittingShelfTagCountInput {
  availableWidth: number;
  localWidth?: number;
  genreWidth: number;
  tagWidths: number[];
  remainderWidths: Map<number, number>;
  gap: number;
  maxTagCount?: number;
}

export const getFittingShelfTagCount = ({
  availableWidth,
  localWidth = 0,
  genreWidth,
  tagWidths,
  remainderWidths,
  gap,
  maxTagCount = tagWidths.length,
}: FittingShelfTagCountInput) => {
  const fixedWidths = [localWidth, genreWidth].filter((width) => width > 0);
  for (let count = Math.min(maxTagCount, tagWidths.length); count >= 0; count -= 1) {
    const remaining = tagWidths.length - count;
    const itemCount = fixedWidths.length + count + (remaining > 0 ? 1 : 0);
    const contentWidth = fixedWidths.reduce((total, width) => total + width, 0)
      + tagWidths.slice(0, count).reduce((total, width) => total + width, 0)
      + (remaining > 0 ? remainderWidths.get(remaining) ?? 0 : 0)
      + Math.max(0, itemCount - 1) * gap;
    if (contentWidth <= availableWidth) return count;
  }
  return 0;
};

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export const BookCard: React.FC<BookCardProps> = ({
  book,
  progress,
  isDownloaded,
  viewMode,
  theme,
  onOpen,
  onDeleteProgress,
  onRequestBookInfo,
  catalog,
  coverUrl,
}) => {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const tagRowRef = useRef<HTMLDivElement | null>(null);
  const tagMeasureRef = useRef<HTMLDivElement | null>(null);
  const [listTagLimit, setListTagLimit] = useState(10);

  const formatDate = (timestamp: unknown) => {
    const time = getProgressTime(timestamp);
    if (!time) return 'Ready to Start';
    const date = new Date(time);
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  };

  const percent = progress?.progressPercent || 0;
  const rawTags = catalog?.tags.filter((tag) => tag.label !== catalog.genreLabel) ?? [];
  const fixedListTagCount = (isDownloaded ? 1 : 0) + (catalog?.genreLabel ? 1 : 0);
  const maxListRawTagCount = Math.max(0, 10 - fixedListTagCount);
  const tagLayoutKey = `${isDownloaded ? 'local' : ''}\u0000${catalog?.genreLabel ?? ''}\u0000${rawTags.map((tag) => `${tag.id}:${tag.label}`).join('\u0000')}`;
  const visibleTags = viewMode === 'grid'
    ? rawTags
    : rawTags.slice(0, Math.min(listTagLimit, maxListRawTagCount));
  const remainingTagCount = viewMode === 'grid'
    ? 0
    : Math.max(0, rawTags.length - visibleTags.length);
  const hasCatalogTags = Boolean(isDownloaded || (catalog && (catalog.genreLabel || rawTags.length > 0)));
  const sourceMetrics = catalog ? [
    { bit: 1, value: catalog.record.sourceCounts[0] },
    { bit: 2, value: catalog.record.sourceCounts[1] },
    { bit: 4, value: catalog.record.sourceCounts[2] },
  ].filter(({ bit }) => Boolean(catalog.record.platformMask & bit)) : [];
  const combinedSourceCount = sourceMetrics.reduce<number | null>((total, { value }) => {
    if (value === null) return total;
    return Math.min(Number.MAX_SAFE_INTEGER, (total ?? 0) + value);
  }, null);

  useClientLayoutEffect(() => {
    if (viewMode !== 'list') return undefined;
    const row = tagRowRef.current;
    const measure = tagMeasureRef.current;
    if (!row || !measure) return undefined;

    const updateTagLimit = () => {
      if (window.matchMedia('(min-width: 640px)').matches) {
        const nextLimit = Math.min(maxListRawTagCount, rawTags.length);
        setListTagLimit((current) => current === nextLimit ? current : nextLimit);
        return;
      }
      const localWidth = measure.querySelector<HTMLElement>(
        '[data-shelf-tag-measure-local="true"]',
      )?.offsetWidth ?? 0;
      const genreWidth = measure.querySelector<HTMLElement>(
        '[data-shelf-tag-measure-genre="true"]',
      )?.offsetWidth ?? 0;
      const tagWidths = [...measure.querySelectorAll<HTMLElement>(
        '[data-shelf-tag-measure-tag="true"]',
      )].map((element) => element.offsetWidth);
      const remainderWidths = new Map(
        [...measure.querySelectorAll<HTMLElement>('[data-shelf-tag-measure-remaining]')]
          .map((element) => [
            Number(element.dataset.shelfTagMeasureRemaining),
            element.offsetWidth,
          ]),
      );
      const parsedGap = Number.parseFloat(window.getComputedStyle(row).columnGap);
      const nextLimit = getFittingShelfTagCount({
        availableWidth: row.clientWidth,
        localWidth,
        genreWidth,
        tagWidths,
        remainderWidths,
        gap: Number.isFinite(parsedGap) ? parsedGap : 4,
        maxTagCount: maxListRawTagCount,
      });
      setListTagLimit((current) => current === nextLimit ? current : nextLimit);
    };

    updateTagLimit();
    let resizeFrame = 0;
    const scheduleTagLimitUpdate = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(updateTagLimit);
    };
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleTagLimitUpdate);
    observer?.observe(row);
    window.addEventListener('resize', scheduleTagLimitUpdate);
    return () => {
      window.cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleTagLimitUpdate);
    };
  }, [tagLayoutKey, viewMode]);

  const localChipClass = 'shrink-0 rounded-md bg-green-500/15 px-1.5 py-0.5 text-[9px] font-black text-green-500';
  const genreChipClass = 'shrink-0 rounded-md bg-accent-500/12 px-1.5 py-0.5 text-[9px] font-black text-accent-500';
  const tagChipClass = 'max-w-24 shrink-0 truncate rounded-md bg-black/5 px-1.5 py-0.5 text-[9px] font-bold opacity-60 dark:bg-white/5';
  const renderCatalogTags = () => (
    hasCatalogTags ? (
      <div className="relative min-w-0">
        <div
          ref={viewMode === 'list' ? tagRowRef : undefined}
          data-shelf-book-tags="true"
          className={`flex min-w-0 items-center gap-x-1 gap-y-0.5 ${
            viewMode === 'list'
              ? 'flex-nowrap overflow-hidden sm:flex-wrap sm:overflow-visible'
              : 'flex-wrap'
          }`}
        >
          {isDownloaded && (
            <span data-shelf-local-tag="true" className={localChipClass}>
              로컬
            </span>
          )}
          {catalog?.genreLabel && (
            <span className={genreChipClass}>
              {catalog.genreLabel}
            </span>
          )}
          {visibleTags.map((tag) => (
            <span key={tag.id} className={tagChipClass}>
              #{tag.label}
            </span>
          ))}
          {remainingTagCount > 0 && (
            <span className="shrink-0 text-[9px] font-bold opacity-40">+{remainingTagCount}</span>
          )}
        </div>
        {viewMode === 'list' && (
          <div
            ref={tagMeasureRef}
            aria-hidden="true"
            className="invisible absolute left-0 top-0 flex items-center gap-x-1 whitespace-nowrap"
          >
            {isDownloaded && (
              <span data-shelf-tag-measure-local="true" className={localChipClass}>
                로컬
              </span>
            )}
            {catalog?.genreLabel && (
              <span data-shelf-tag-measure-genre="true" className={genreChipClass}>
                {catalog.genreLabel}
              </span>
            )}
            {rawTags.map((tag) => (
              <span key={tag.id} data-shelf-tag-measure-tag="true" className={tagChipClass}>
                #{tag.label}
              </span>
            ))}
            {rawTags.map((_, index) => {
              const remaining = rawTags.length - index;
              return (
                <span
                  key={remaining}
                  data-shelf-tag-measure-remaining={remaining}
                  className="shrink-0 text-[9px] font-bold"
                >
                  +{remaining}
                </span>
              );
            })}
          </div>
        )}
      </div>
    ) : null
  );
  const renderCatalogSources = (placement: 'card' | 'list-progress' = 'card') => combinedSourceCount !== null ? (
    <div
      data-shelf-book-sources="true"
      className={placement === 'list-progress'
        ? 'flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-1 gap-y-0 text-right text-[8px] font-bold leading-tight opacity-50 sm:text-[9px]'
        : 'flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] font-bold opacity-50'}
    >
      <span
        className={placement === 'list-progress'
          ? 'max-w-full shrink-0 truncate whitespace-nowrap'
          : 'shrink-0 whitespace-nowrap'}
      >
        {formatPublicBookCatalogMetric(combinedSourceCount)} 조회
      </span>
    </div>
  ) : null;
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
    longPressStartRef.current = null;
  }, []);

  const startLongPress = useCallback((event: React.PointerEvent) => {
    if (!onRequestBookInfo || (event.pointerType === 'mouse' && event.button !== 0)) return;
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
      longPressTriggeredRef.current = true;
      onRequestBookInfo(book);
    }, 650);
  }, [book, clearLongPressTimer, onRequestBookInfo]);

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const start = longPressStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) {
      clearLongPressTimer();
    }
  }, [clearLongPressTimer]);

  const handleCardClick = useCallback(() => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    onOpen(book);
  }, [book, onOpen]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    if (!onRequestBookInfo) return;
    event.preventDefault();
    onRequestBookInfo(book);
  }, [book, onRequestBookInfo]);

  if (viewMode === 'list') {
    return (
      <div 
        data-shelf-book-card="true"
        data-shelf-book-id={book.id}
        onClick={handleCardClick}
        onContextMenu={handleContextMenu}
        onPointerDown={startLongPress}
        onPointerMove={handlePointerMove}
        onPointerUp={clearLongPressTimer}
        onPointerLeave={clearLongPressTimer}
        onPointerCancel={clearLongPressTimer}
        className={`group grid select-none grid-cols-[2.75rem_minmax(0,1fr)_6rem] items-center gap-3 border-b ${theme.border} px-1 py-2.5 cursor-pointer transition-colors duration-200 [-webkit-touch-callout:none] hover:bg-white/5 sm:grid-cols-[3rem_minmax(0,1fr)_4rem_10rem] sm:gap-4 sm:px-3 sm:py-3`}
      >
        <div
          data-shelf-book-cover-frame="true"
          className="relative h-16 w-11 overflow-hidden transition-transform duration-200 group-hover:scale-105 sm:-my-1 sm:h-[4.25rem] sm:w-12"
        >
          {coverUrl ? (
            <Image
              data-shelf-book-cover="true"
              src={coverUrl}
              alt=""
              fill
              sizes="48px"
              unoptimized
              className="object-cover"
            />
          ) : (
            <GeneratedBookCover
              identity={book.id}
              title={getDisplayBookTitle(book.name)}
              variant="list"
            />
          )}
        </div>
        
        <div className="min-w-0">
          <div data-shelf-title-tag-group="true" className="flex min-h-10 flex-col justify-center">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="min-w-0 flex-1 truncate text-sm font-bold leading-tight group-hover:text-accent-500 transition-colors sm:text-base">
                {getDisplayBookTitle(book.name)}
              </h3>
            </div>
            <div
              data-shelf-tag-transition="true"
              aria-hidden={!hasCatalogTags}
              className={`grid transition-[grid-template-rows,opacity,margin-top] duration-300 ease-out motion-reduce:transition-none ${
                hasCatalogTags
                  ? 'mt-1 grid-rows-[1fr] opacity-100'
                  : 'mt-0 grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="min-h-0 overflow-hidden">{renderCatalogTags()}</div>
            </div>
          </div>
          <div data-shelf-book-time="true" className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-widest text-slate-500 sm:text-[11px]">
            {progress?.lastRead && percent > 0 ? formatDate(progress.lastRead) : 'Ready to Start'}
          </div>
        </div>


        <div
          data-shelf-list-format="true"
          className="hidden min-w-0 text-center text-[11px] font-bold uppercase tracking-widest text-slate-500 sm:block"
        >
          {getBookFormatLabel(book)}
        </div>

        <div data-shelf-list-progress="true" className="min-w-0 self-stretch flex flex-col items-end justify-start pt-0.5">
          {combinedSourceCount !== null && (
            <div data-shelf-list-source-slot="true" className="mb-1 w-full min-w-0">
              {renderCatalogSources('list-progress')}
            </div>
          )}
          <div className="mb-1 flex items-center justify-end gap-1.5">
            {percent > 0 && onDeleteProgress && (
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteProgress(book.id);
                }}
                onPointerDown={(e) => e.stopPropagation()}
                className="text-slate-500 hover:text-red-400 hover:bg-white/5 rounded-full p-1.5 transition-colors"
                title="Delete Progress"
              >
                <Eraser size={16} strokeWidth={2.5} />
              </button>
            )}
            <span className="text-xs font-black text-accent-400 sm:text-sm">
              {percent.toFixed(1)}%
            </span>
          </div>
          <div className="ml-auto h-1.5 w-full max-w-24 bg-black/30 rounded-full overflow-hidden sm:max-w-32">
            <div 
              className="h-full bg-accent-500 rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      data-shelf-book-card="true"
      data-shelf-book-id={book.id}
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onPointerDown={startLongPress}
      onPointerMove={handlePointerMove}
      onPointerUp={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      className={`group relative flex select-none flex-col ${theme.secondary} border ${theme.border} rounded-[2.5rem] p-6 cursor-pointer hover:border-accent-500/50 transition-all duration-500 [-webkit-touch-callout:none] hover:-translate-y-2 overflow-hidden`}
    >
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <div data-shelf-grid-cover-content="true" className="flex min-h-0 flex-col">
          <div
            data-shelf-grid-cover-layout="true"
            className="grid min-h-36 grid-cols-[6rem_minmax(0,1fr)] items-start gap-4 sm:min-h-40 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-5"
          >
            <div
              data-shelf-book-cover-frame="true"
              className="relative h-36 w-24 overflow-hidden transition-transform duration-500 group-hover:scale-[1.04] sm:h-40 sm:w-28"
            >
              {coverUrl ? (
                <Image
                  data-shelf-book-cover="true"
                  src={coverUrl}
                  alt=""
                  fill
                  sizes="(min-width: 640px) 112px, 96px"
                  unoptimized
                  className="object-cover"
                />
              ) : (
                <GeneratedBookCover
                  identity={book.id}
                  title={getDisplayBookTitle(book.name)}
                  variant="grid"
                />
              )}
            </div>
            <div className="flex h-36 min-w-0 flex-col pt-0.5 sm:h-40">
              <h3
                data-shelf-grid-cover-title="true"
                className="min-w-0 text-lg font-bold leading-tight line-clamp-4 group-hover:text-accent-500 transition-colors sm:text-xl"
              >
                {getDisplayBookTitle(book.name)}
              </h3>
              <div data-shelf-grid-cover-bottom-meta="true" className="mt-auto">
                <div data-shelf-grid-meta="true" className="flex items-center gap-2">
                  <span className="text-xs font-bold uppercase tracking-widest text-slate-500">
                    {getBookFormatLabel(book)}
                  </span>
                </div>
                {combinedSourceCount !== null && (
                  <div data-shelf-grid-cover-source-slot="true" className="mt-2 min-h-3">
                    {renderCatalogSources()}
                  </div>
                )}
              </div>
            </div>
          </div>
          {hasCatalogTags && (
            <div data-shelf-grid-cover-tag-slot="true" className="mt-2 flex min-h-9 items-center">
              <div
                data-shelf-grid-cover-tags="true"
                className="max-h-9 w-full overflow-hidden"
              >
                {renderCatalogTags()}
              </div>
            </div>
          )}
        </div>

        <div data-shelf-grid-progress-block="true" className="mt-auto space-y-2 pt-3">
          <div className="flex justify-between items-end">
            <span data-shelf-grid-progress-date="true" className="text-[10px] font-black uppercase leading-none text-slate-500 tracking-tighter">
              {progress?.lastRead && percent > 0 ? formatDate(progress.lastRead) : 'Ready to Start'}
            </span>
            <div className="flex items-end gap-1.5">
              {percent > 0 && onDeleteProgress && (
                <button 
                  data-shelf-grid-progress-delete="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProgress(book.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="flex h-5 w-5 items-center justify-center rounded-full p-0 text-slate-500 transition-colors hover:bg-white/5 hover:text-red-400"
                  title="Delete Progress"
                >
                  <Eraser size={18} strokeWidth={2.5} />
                </button>
              )}
              <span data-shelf-grid-progress-percent="true" className="text-xs font-black leading-none text-accent-400">{percent.toFixed(1)}%</span>
            </div>
          </div>
          <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
            <div 
              className="h-full bg-accent-500 rounded-full transition-all duration-1000 ease-out"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
