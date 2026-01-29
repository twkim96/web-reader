// src/components/Shelf.tsx
import React, { useState, useEffect } from 'react';
import { Book, UserProgress } from '../types';
import { getOfflineBookIds } from '../lib/localDB'; // 추가됨
import { ManageModal } from './ManageModal'; // 추가됨
import { 
  Library, 
  RefreshCcw, 
  BookOpen, 
  FolderPlus,
  LogOut,
  HardDrive, // 아이콘 추가
  CheckCircle2 // 아이콘 추가
} from 'lucide-react';

interface ShelfProps {
  books: Book[];
  progress: Record<string, UserProgress>;
  onOpen: (book: Book) => void;
  onRefresh: () => void;
  onLogout: () => void;
  isRefreshing: boolean;
  userEmail: string;
}

export const Shelf: React.FC<ShelfProps> = ({ 
  books, 
  progress, 
  onOpen, 
  onRefresh, 
  onLogout,
  isRefreshing,
  userEmail 
}) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());
  const [showManage, setShowManage] = useState(false);

  // 로컬 저장된 책 목록 확인
  const checkOfflineStatus = async () => {
    const ids = await getOfflineBookIds();
    setOfflineIds(ids);
  };

  useEffect(() => {
    checkOfflineStatus();
  }, [books]); // 책 목록이 바뀌거나, 마운트될 때 확인

  const formatDate = (timestamp: any) => {
    if (!timestamp) return 'Ready to Start';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return 'Ready to Start';
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-200 font-sans pb-20">
      {/* 상단 헤더 */}
      <header className="sticky top-0 z-40 bg-[#0f172a]/80 backdrop-blur-md border-b border-white/5 px-6 py-6">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-indigo-600 rounded-2xl shadow-lg shadow-indigo-500/20">
              <Library className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-xl font-black text-white tracking-tight uppercase italic">My Library</h1>
              <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">{userEmail}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {/* 1. 도서 관리 버튼 (신규) */}
            <button 
              onClick={() => setShowManage(true)}
              className="p-4 rounded-2xl bg-white/5 border border-white/10 text-slate-400 hover:text-indigo-400 hover:bg-white/10 transition-all active:scale-90"
              title="Manage Offline Books"
            >
              <HardDrive size={20} />
            </button>

            {/* 새로고침 버튼 */}
            <button 
              onClick={onRefresh}
              disabled={isRefreshing}
              className={`p-4 rounded-2xl bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:bg-white/10 transition-all ${isRefreshing ? 'animate-spin opacity-50' : 'active:scale-90'}`}
              title="Refresh Library"
            >
              <RefreshCcw size={20} />
            </button>

            {/* 로그아웃 버튼 */}
            <button 
              onClick={onLogout}
              className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all active:scale-90"
              title="Sign Out"
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* 메인 콘텐츠 영역 */}
      <main className="max-w-7xl mx-auto px-6 py-12">
        {books.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
            {books.map((book) => {
              const bookProgress = progress[book.id];
              const isDownloaded = offlineIds.has(book.id);

              return (
                <div 
                  key={book.id}
                  onClick={() => onOpen(book)}
                  className="group relative bg-white/5 border border-white/10 rounded-[2.5rem] p-8 cursor-pointer hover:bg-white/10 hover:border-indigo-500/50 transition-all duration-500 hover:-translate-y-2 overflow-hidden"
                >
                  <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:opacity-20 transition-opacity">
                    <BookOpen size={100} className="rotate-12" />
                  </div>

                  <div className="relative z-10 space-y-6">
                    <div className="flex justify-between items-start">
                      <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl group-hover:scale-110 transition-transform duration-500">
                        <BookOpen className="text-white" size={28} />
                      </div>
                      
                      {/* 2. 다운로드 완료 아이콘 (신규) */}
                      {isDownloaded && (
                        <div className="p-2 bg-green-500/20 rounded-full border border-green-500/30 text-green-400 animate-in zoom-in duration-300">
                          <CheckCircle2 size={16} strokeWidth={3} />
                        </div>
                      )}
                    </div>
                    
                    <div>
                      <h3 className="text-lg font-bold text-white leading-tight line-clamp-2 group-hover:text-indigo-300 transition-colors">
                        {book.name.replace('.txt', '')}
                      </h3>
                      <p className="text-xs text-slate-500 font-bold mt-2 uppercase tracking-widest">Text Document</p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex justify-between items-end">
                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">
                          {bookProgress?.lastRead ? formatDate(bookProgress.lastRead) : 'Ready to Start'}
                        </span>
                        <span className="text-xs font-black text-indigo-400">{bookProgress?.progressPercent?.toFixed(1) || '0.0'}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-indigo-500 rounded-full transition-all duration-1000 ease-out"
                          style={{ width: `${bookProgress?.progressPercent || 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-32 text-center space-y-8 bg-white/5 rounded-[3.5rem] border border-white/10 backdrop-blur-sm">
            <div className="p-8 bg-indigo-600/20 rounded-[2rem] text-indigo-400 shadow-inner">
              <FolderPlus size={64} />
            </div>
            <div className="space-y-4 max-w-sm">
              <h3 className="text-2xl font-black text-white italic uppercase tracking-tighter">No Books Found</h3>
              <p className="text-slate-400 text-sm leading-relaxed font-medium">
                구글 드라이브에 <span className="text-indigo-400 font-black">"web viewer"</span> 폴더를 생성하고, 읽고 싶은 <span className="text-indigo-400 font-black">.txt</span> 파일을 업로드해 주세요.
              </p>
            </div>
            <button 
              onClick={onRefresh}
              className="px-10 py-4 bg-white text-[#0f172a] rounded-full font-black text-xs uppercase tracking-[0.2em] hover:bg-indigo-500 hover:text-white transition-all shadow-2xl active:scale-95"
            >
              Refresh Library
            </button>
          </div>
        )}
      </main>

      {/* 3. 모달 (신규) */}
      {showManage && (
        <ManageModal 
          onClose={() => setShowManage(false)} 
          onUpdate={checkOfflineStatus} // 삭제 시 Shelf 상태 갱신
          theme={{ bg: 'bg-[#0f172a]', text: 'text-white' }}
        />
      )}
    </div>
  );
};