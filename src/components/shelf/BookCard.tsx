import React, { useCallback, useRef } from 'react';
import { BookOpen, CheckCircle2, Eraser } from 'lucide-react';
import { Book, UserProgress } from '../../types';
import { getDisplayBookTitle, getProgressTime, ShelfTheme } from './bookUtils';

interface BookCardProps {
  book: Book;
  progress?: UserProgress;
  isDownloaded: boolean;
  viewMode: 'grid' | 'list';
  theme: ShelfTheme;
  onOpen: (book: Book) => void;
  onDeleteProgress?: (bookId: string) => void;
  onRequestDeleteBook?: (book: Book) => void;
}

export const BookCard: React.FC<BookCardProps> = ({
  book,
  progress,
  isDownloaded,
  viewMode,
  theme,
  onOpen,
  onDeleteProgress,
  onRequestDeleteBook
}) => {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const formatDate = (timestamp: unknown) => {
    const time = getProgressTime(timestamp);
    if (!time) return 'Ready to Start';
    const date = new Date(time);
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  };

  const percent = progress?.progressPercent || 0;
  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);

  const startLongPress = useCallback(() => {
    if (!onRequestDeleteBook) return;
    clearLongPressTimer();
    longPressTriggeredRef.current = false;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      onRequestDeleteBook(book);
    }, 650);
  }, [book, clearLongPressTimer, onRequestDeleteBook]);

  const handleCardClick = useCallback(() => {
    if (longPressTriggeredRef.current) {
      longPressTriggeredRef.current = false;
      return;
    }
    onOpen(book);
  }, [book, onOpen]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    if (!onRequestDeleteBook) return;
    event.preventDefault();
    onRequestDeleteBook(book);
  }, [book, onRequestDeleteBook]);

  if (viewMode === 'list') {
    return (
      <div 
        onClick={handleCardClick}
        onContextMenu={handleContextMenu}
        onPointerDown={startLongPress}
        onPointerUp={clearLongPressTimer}
        onPointerLeave={clearLongPressTimer}
        onPointerCancel={clearLongPressTimer}
        className={`group flex items-center ${theme.secondary} border ${theme.border} rounded-3xl p-4 sm:p-5 cursor-pointer hover:border-accent-500/50 transition-all duration-300`}
      >
        <div className="w-12 h-12 bg-accent-600 rounded-xl flex items-center justify-center shrink-0 shadow-lg group-hover:scale-105 transition-transform duration-300 mr-4">
          <BookOpen className="text-white" size={20} />
        </div>
        
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-2">
            <h3 className="text-base sm:text-lg font-bold truncate group-hover:text-accent-500 transition-colors">
              {getDisplayBookTitle(book.name)}
            </h3>
            {isDownloaded && (
              <CheckCircle2 size={16} className="text-green-400 shrink-0" strokeWidth={3} />
            )}
          </div>
          <div className="text-[10px] text-slate-500 font-bold mt-1 uppercase tracking-widest truncate">
            {progress?.lastRead && percent > 0 ? formatDate(progress.lastRead) : 'Ready to Start'}
          </div>
        </div>

        <div className="w-20 sm:w-32 shrink-0 flex flex-col justify-center">
          <div className="flex justify-end mb-1.5 items-center gap-1.5">
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
            <span className="text-xs font-black text-accent-400">
              {percent.toFixed(1)}%
            </span>
          </div>
          <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
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
      onClick={handleCardClick}
      onContextMenu={handleContextMenu}
      onPointerDown={startLongPress}
      onPointerUp={clearLongPressTimer}
      onPointerLeave={clearLongPressTimer}
      onPointerCancel={clearLongPressTimer}
      className={`group relative ${theme.secondary} border ${theme.border} rounded-[2.5rem] p-8 cursor-pointer hover:border-accent-500/50 transition-all duration-500 hover:-translate-y-2 overflow-hidden`}
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
          <p className="text-xs text-slate-500 font-bold mt-2 uppercase tracking-widest">EPUB Document</p>
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
