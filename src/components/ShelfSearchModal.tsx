import React, { useDeferredValue, useMemo, useState } from 'react';
import { Search, X, BookOpen, ChevronRight, CheckCircle2 } from 'lucide-react';
import { Book, UserProgress } from '../types';
import {
  filterAndSortPreparedBooks,
  getDisplayBookTitle,
  getProgressTime,
  PreparedShelfBook,
  ShelfSortMode,
  ShelfTheme,
} from './shelf/bookUtils';

interface ShelfSearchModalProps {
  onClose: () => void;
  onSearch: (keyword: string) => void;
  initialKeyword: string;
  theme: ShelfTheme;
  books: PreparedShelfBook[];
  sortMode: ShelfSortMode;
  onOpen: (book: Book) => void;
  progress: Record<string, UserProgress>;
  offlineIds: Set<string>;
  isOfflineMode: boolean;
}

export const ShelfSearchModal: React.FC<ShelfSearchModalProps> = ({ 
  onClose, 
  onSearch,
  initialKeyword,
  theme,
  books,
  onOpen,
  progress,
  offlineIds,
  isOfflineMode,
  sortMode,
}) => {
  const [keyword, setKeyword] = useState(initialKeyword);
  const deferredKeyword = useDeferredValue(keyword);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(keyword);
    onClose();
  };

  const formatDate = (timestamp: unknown) => {
    const time = getProgressTime(timestamp);
    if (!time) return null;
    const date = new Date(time);
    return date.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };

  const filteredBooks = useMemo(
    () => deferredKeyword
      ? filterAndSortPreparedBooks(books, deferredKeyword, sortMode).slice(0, 5)
      : [],
    [books, deferredKeyword, sortMode],
  );

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[15vh] p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className={`w-full max-w-2xl ${theme.bg} ${theme.text} rounded-[2rem] shadow-2xl border ${theme.border} overflow-hidden flex flex-col animate-in slide-in-from-top-4 zoom-in-95 duration-300`}
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="relative flex items-center p-2">
          <div className="pl-6 pr-2">
            <Search className="opacity-50" size={28} />
          </div>
          <input
            autoFocus
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="도서 이름으로 검색..."
            className={`w-full py-6 pr-6 bg-transparent text-xl focus:outline-none font-bold placeholder:opacity-30`}
          />
          {keyword && (
            <button 
              type="button"
              onClick={() => { setKeyword(''); onSearch(''); onClose(); }}
              className="mr-4 p-2 rounded-full opacity-50 hover:bg-black/10 hover:opacity-100 transition-all"
            >
              <X size={20} />
            </button>
          )}
        </form>

        {keyword && (
           <div className={`border-t ${theme.border}`}>
             {filteredBooks.length > 0 ? (
               <div className="py-2">
                 <div className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-accent-500">Books</div>
                 {filteredBooks.map(book => {
                   const bookProgress = progress[book.id];
                   const isDownloaded = isOfflineMode || offlineIds.has(book.id);
                   const lastDate = formatDate(bookProgress?.lastRead);
                   const percent = bookProgress?.progressPercent;

                   return (
                     <button
                       key={book.id}
                       type="button"
                       onClick={() => { onClose(); onOpen(book); }}
                       className={`w-full flex items-center gap-4 px-6 py-4 text-left hover:bg-accent-500/10 transition-colors group`}
                     >
                       <div className="relative">
                         <div className={`p-2 rounded-xl bg-accent-500/10 text-accent-500`}>
                           <BookOpen size={20} />
                         </div>
                         {isDownloaded && (
                           <div className="absolute -top-1.5 -right-1.5 bg-green-500 text-white rounded-full p-0.5 border-2 border-white dark:border-slate-900 shadow-sm">
                             <CheckCircle2 size={10} strokeWidth={4} />
                           </div>
                         )}
                       </div>
                       
                       <div className="flex-1 min-w-0 flex items-center justify-between gap-4">
                         <span className="font-bold truncate text-base group-hover:text-accent-500 transition-colors">
                           {getDisplayBookTitle(book.name)}
                         </span>
                         {(lastDate || percent !== undefined) && (
                           <div className="flex items-center gap-3 shrink-0">
                             {lastDate && <span className="opacity-40 text-[10px] font-bold uppercase tracking-tight">{lastDate}</span>}
                             {percent !== undefined && percent > 0 && (
                               <span className="text-accent-500 text-xs font-black bg-accent-500/10 px-2 py-0.5 rounded-md">
                                 {percent.toFixed(1)}%
                               </span>
                             )}
                           </div>
                         )}
                       </div>
                       
                       <ChevronRight className="opacity-0 group-hover:opacity-40 text-accent-500 transition-opacity shrink-0" size={16} />
                     </button>
                   );
                 })}
               </div>
             ) : (
                <div className="py-12 text-center opacity-50 font-bold text-sm">
                  검색 결과가 없습니다.
                </div>
             )}
             
             {filteredBooks.length > 0 && (
                <div className={`p-4 border-t ${theme.border} ${theme.secondary} text-center flex justify-center`}>
                  <button type="submit" onClick={handleSubmit} className="text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100 bg-black/5 px-4 py-2 rounded-full transition-all flex items-center gap-2">
                    <Search size={14} /> 전체 검색 결과 화면 보기
                  </button>
                </div>
             )}
           </div>
        )}
      </div>
    </div>
  );
};
