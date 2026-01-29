import React from 'react';
import { Book, UserProgress } from '../types';
import { 
  BookOpen, RefreshCw, Clock, HardDrive, 
  FileText, User as UserIcon 
} from 'lucide-react';

interface ShelfProps {
  books: Book[];
  progress: Record<string, UserProgress>;
  isRefreshing: boolean;
  onRefresh: () => void;
  onOpen: (book: Book) => void;
  userEmail?: string | null;
}

export const Shelf: React.FC<ShelfProps> = ({ 
  books, progress, isRefreshing, onRefresh, onOpen, userEmail 
}) => (
  <div className="bg-slate-50 min-h-screen flex flex-col">
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center sticky top-0 z-10">
      <div className="flex items-center gap-3">
        <div className="bg-indigo-600 p-2 rounded-xl text-white shadow-lg">
          <BookOpen size={20} />
        </div>
        <h1 className="font-black text-xl tracking-tight text-slate-800 italic uppercase">Cloud Reader</h1>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onRefresh} disabled={isRefreshing} className={`p-2 hover:bg-slate-100 rounded-full text-slate-500 ${isRefreshing ? 'animate-spin' : ''}`}>
          <RefreshCw size={20} />
        </button>
        <div className="h-8 w-px bg-slate-200 mx-2" />
        <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full">
          <UserIcon size={14} className="text-slate-400" />
          <span className="text-xs font-bold text-slate-600">{userEmail?.split('@')[0] || 'User'}</span>
        </div>
      </div>
    </header>
    <main className="flex-1 max-w-6xl mx-auto w-full p-6">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-slate-800 tracking-tight">내 서재</h2>
        <p className="text-sm text-slate-500 mt-1">'web reader' 폴더의 텍스트 파일들입니다.</p>
      </div>
      {books.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-4">
          <HardDrive size={64} strokeWidth={1} />
          <p className="font-medium">도서가 없습니다.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6">
          {books.map((book) => {
            const bookProgress = progress[book.id];
            return (
              <div key={book.id} onClick={() => onOpen(book)} className="group flex flex-col cursor-pointer">
                <div className="aspect-[3/4] bg-slate-800 rounded-2xl shadow-sm group-hover:shadow-2xl group-hover:-translate-y-2 transition-all duration-300 flex flex-col justify-end p-5 text-white relative overflow-hidden border border-slate-700">
                  <div className="absolute top-0 right-0 p-4 opacity-10">
                    <FileText size={80} strokeWidth={1} />
                  </div>
                  <h3 className="font-bold leading-tight line-clamp-3 text-sm">{book.name.replace('.txt', '')}</h3>
                </div>
                <div className="mt-4 space-y-1.5 px-1">
                  <div className="flex justify-between items-center text-[10px] font-black text-slate-400 uppercase">
                    <span>{bookProgress ? `${Math.round(bookProgress.progressPercent)}%` : '미독'}</span>
                    <Clock size={10} />
                  </div>
                  <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full transition-all duration-700" style={{ width: `${bookProgress?.progressPercent || 0}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  </div>
);