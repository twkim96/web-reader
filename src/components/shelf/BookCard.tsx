import React, { useCallback, useRef } from 'react';
import { BookOpen, CheckCircle2, Eraser } from 'lucide-react';
import { Book, UserProgress } from '../../types';
import {
  formatPublicBookCatalogMetric,
  type PublicBookCatalogBook,
} from '../../lib/publicBookCatalog';
import { getBookFormatLabel, getDisplayBookTitle, getProgressTime, ShelfTheme } from './bookUtils';

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
}

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
}) => {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const longPressStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

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
  const visibleTags = rawTags.slice(0, viewMode === 'list' ? 5 : 2);
  const remainingTagCount = Math.max(0, rawTags.length - visibleTags.length);
  const hasCatalogTags = Boolean(catalog && (catalog.genreLabel || visibleTags.length > 0));
  const sourceMetrics = catalog ? [
    { bit: 1, value: catalog.record.sourceCounts[0] },
    { bit: 2, value: catalog.record.sourceCounts[1] },
    { bit: 4, value: catalog.record.sourceCounts[2] },
  ].filter(({ bit }) => Boolean(catalog.record.platformMask & bit)) : [];
  const combinedSourceCount = sourceMetrics.reduce<number | null>((total, { value }) => {
    if (value === null) return total;
    return Math.min(Number.MAX_SAFE_INTEGER, (total ?? 0) + value);
  }, null);
  const renderCatalogTags = () => (
    catalog && (catalog.genreLabel || visibleTags.length > 0) ? (
      <div data-shelf-book-tags="true" className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
        {catalog.genreLabel && (
          <span className="shrink-0 rounded-md bg-accent-500/12 px-1.5 py-0.5 text-[9px] font-black text-accent-500">
            {catalog.genreLabel}
          </span>
        )}
        {visibleTags.map((tag) => (
          <span key={tag.id} className="max-w-24 truncate rounded-md bg-black/5 px-1.5 py-0.5 text-[9px] font-bold opacity-60 dark:bg-white/5">
            #{tag.label}
          </span>
        ))}
        {remainingTagCount > 0 && (
          <span className="shrink-0 text-[9px] font-bold opacity-40">+{remainingTagCount}</span>
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
        className={`group grid select-none grid-cols-[2.75rem_minmax(0,1fr)_6rem] items-center gap-3 border-b ${theme.border} px-1 py-2.5 cursor-pointer transition-colors duration-200 [-webkit-touch-callout:none] hover:bg-white/5 sm:grid-cols-[3rem_minmax(0,1.15fr)_9rem_10rem] sm:gap-5 sm:px-3 sm:py-3`}
      >
        <div className="h-11 w-11 bg-accent-600 rounded-xl flex items-center justify-center shrink-0 shadow-md group-hover:scale-105 transition-transform duration-200 sm:h-12 sm:w-12">
          <BookOpen className="text-white" size={22} />
        </div>
        
        <div className="min-w-0">
          <div data-shelf-title-tag-group="true" className="flex min-h-10 flex-col justify-center">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-bold leading-tight group-hover:text-accent-500 transition-colors sm:text-base">
                {getDisplayBookTitle(book.name)}
              </h3>
              {isDownloaded && (
                <CheckCircle2 size={15} className="text-green-400 shrink-0" strokeWidth={3} />
              )}
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

        <div className="hidden min-w-0 text-[11px] font-bold uppercase tracking-widest text-slate-500 sm:block">
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
      className={`group relative select-none ${theme.secondary} border ${theme.border} rounded-[2.5rem] p-8 cursor-pointer hover:border-accent-500/50 transition-all duration-500 [-webkit-touch-callout:none] hover:-translate-y-2 overflow-hidden`}
    >
      <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
        <BookOpen size={100} className="rotate-12" />
      </div>

      <div className="relative z-10 space-y-6">
        <div className="flex justify-between items-start">
          <div className="w-14 h-14 bg-accent-600 rounded-2xl flex items-center justify-center shadow-xl group-hover:scale-110 transition-transform duration-500">
            <BookOpen className="text-white" size={28} />
          </div>
          
          {isDownloaded && (
            <div className="p-2 bg-green-500/20 rounded-full border border-green-500/30 text-green-400 animate-in zoom-in duration-300">
              <CheckCircle2 size={16} strokeWidth={3} />
            </div>
          )}
        </div>
        
        <div>
          <h3 className="text-lg font-bold leading-tight line-clamp-2 group-hover:text-accent-500 transition-colors">
            {getDisplayBookTitle(book.name)}
          </h3>
          <p className="text-xs text-slate-500 font-bold mt-2 uppercase tracking-widest">
            {getBookFormatLabel(book)}
          </p>
          <div className="mt-2 min-h-4">{renderCatalogTags()}</div>
          {combinedSourceCount !== null && <div className="mt-1 min-h-3">{renderCatalogSources()}</div>}
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-end">
            <span className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">
              {progress?.lastRead && percent > 0 ? formatDate(progress.lastRead) : 'Ready to Start'}
            </span>
            <div className="flex items-center gap-1.5">
              {percent > 0 && onDeleteProgress && (
                <button 
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteProgress(book.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="text-slate-500 hover:text-red-400 hover:bg-white/5 rounded-full p-2 transition-colors"
                  title="Delete Progress"
                >
                  <Eraser size={18} strokeWidth={2.5} />
                </button>
              )}
              <span className="text-xs font-black text-accent-400">{percent.toFixed(1)}%</span>
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
