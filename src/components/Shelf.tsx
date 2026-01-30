// src/components/Shelf.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Book, UserProgress } from '../types';
import { getOfflineBookIds } from '../lib/localDB';
import { ManageModal } from './ManageModal';
import { ShelfSearchModal } from './ShelfSearchModal'; // 신규 모달 임포트
import { 
  Library, 
  Search, // 아이콘 변경 (RefreshCcw -> Search)
  BookOpen, 
  FolderPlus,
  LogOut,
  HardDrive,
  CheckCircle2,
  XCircle // 검색 결과 없음 아이콘용
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
  onRefresh, // 인터페이스 유지를 위해 남겨둠 (실제 버튼은 제거됨)
  onLogout,
  isRefreshing, // 인터페이스 유지를 위해 남겨둠
  userEmail 
}) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());
  const [showManage, setShowManage] = useState(false);
  
  // 검색 관련 상태 추가
  const [showSearch, setShowSearch] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");

  // 상태 감지용 Ref
  const stateRef = useRef({ showManage, showSearch });
  useEffect(() => {
    stateRef.current = { showManage, showSearch };
  }, [showManage, showSearch]);

  // History 처리: 모달이 열려있으면 뒤로가기 시 모달만 닫기
  useEffect(() => {
    // Shelf 마운트 시 History state 추가 (뒤로가기 제어권 확보)
    window.history.pushState({ panel: 'shelf' }, '', '');

    const handlePopState = (event: PopStateEvent) => {
      const { showManage, showSearch } = stateRef.current;
      
      if (showManage || showSearch) {
        // 모달 닫기
        if (showManage) setShowManage(false);
        if (showSearch) setShowSearch(false);
        
        // 다시 state를 push하여 Shelf 화면 유지 (앱 종료 방지)
        window.history.pushState({ panel: 'shelf' }, '', '');
      } else {
        // 모달이 없으면 브라우저 기본 동작 허용 (뒤로 이동 or 앱 종료 등)
        // 만약 여기서 강제로 앱 종료를 막고 싶다면 pushState를 또 하면 됩니다.
        // 현재는 모달 닫기 기능만 수행하도록 합니다.
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const checkOfflineStatus = async () => {
    const ids = await getOfflineBookIds();
    setOfflineIds(ids);
  };

  useEffect(() => {
    checkOfflineStatus();
  }, [books]);

  const formatDate = (timestamp: any) => {
    if (!timestamp) return 'Ready to Start';
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return 'Ready to Start';
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  };

  // 검색어 필터링 로직
  const filteredBooks = books.filter(book => 
    book.name.toLowerCase().includes(searchKeyword.toLowerCase())
  );

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
            {/* 도서 관리 버튼 */}
            <button 
              onClick={() => setShowManage(true)}
              className="p-4 rounded-2xl bg-white/5 border border-white/10 text-slate-400 hover:text-indigo-400 hover:bg-white/10 transition-all active:scale-90"
              title="Manage Offline Books"
            >
              <HardDrive size={20} />
            </button>

            {/* [변경] 검색 버튼 (기존 새로고침 버튼 대체) */}
            <button 
              onClick={() => setShowSearch(true)}
              className={`p-4 rounded-2xl border transition-all active:scale-90 ${
                searchKeyword 
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow-lg shadow-indigo-500/20' 
                  : 'bg-white/5 border-white/10 text-slate-400 hover:text-white hover:bg-white/10'
              }`}
              title="Search Books"
            >
              <Search size={20} />
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

      {/* 검색 필터 상태 표시 (검색어가 있을 때만) */}
      {searchKeyword && (
        <div className="max-w-7xl mx-auto px-6 pt-4 pb-0">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="text-indigo-400 font-bold">"{searchKeyword}"</span>
            <span>검색 결과</span>
            <span className="bg-white/10 px-2 py-0.5 rounded-md text-xs font-bold text-white">
              {filteredBooks.length}
            </span>
            <button 
              onClick={() => setSearchKeyword('')} 
              className="ml-auto text-xs font-bold text-slate-500 hover:text-white uppercase tracking-wider"
            >
              Clear Filter
            </button>
          </div>
        </div>
      )}

      {/* 메인 콘텐츠 영역 */}
      <main className="max-w-7xl mx-auto px-6 py-8">
        {filteredBooks.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
            {filteredBooks.map((book) => {
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
          /* 도서가 없거나 검색 결과가 없을 때 */
          <div className="flex flex-col items-center justify-center py-32 text-center space-y-8 bg-white/5 rounded-[3.5rem] border border-white/10 backdrop-blur-sm">
            {searchKeyword ? (
              <>
                <div className="p-8 bg-slate-700/50 rounded-[2rem] text-slate-400">
                  <XCircle size={64} />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold text-white">검색 결과가 없습니다</h3>
                  <p className="text-slate-500 text-sm">"{searchKeyword}"</p>
                </div>
                <button 
                  onClick={() => setSearchKeyword('')}
                  className="px-8 py-3 bg-white/10 text-white rounded-full font-bold text-xs uppercase hover:bg-white/20 transition-all"
                >
                  전체 목록 보기
                </button>
              </>
            ) : (
              <>
                <div className="p-8 bg-indigo-600/20 rounded-[2rem] text-indigo-400 shadow-inner">
                  <FolderPlus size={64} />
                </div>
                <div className="space-y-4 max-w-sm">
                  <h3 className="text-2xl font-black text-white italic uppercase tracking-tighter">No Books Found</h3>
                  <p className="text-slate-400 text-sm leading-relaxed font-medium">
                    구글 드라이브에 <span className="text-indigo-400 font-black">"web viewer"</span> 폴더를 생성하고, 읽고 싶은 <span className="text-indigo-400 font-black">.txt</span> 파일을 업로드해 주세요.
                  </p>
                </div>
                {/* 데이터가 아예 없을 때는 여전히 Refresh 버튼을 보여주는 것이 유용할 수 있으나, 요청에 따라 제거하거나 상단 로직에 의존합니다. 여기서는 새로고침을 유지합니다. */}
                <button 
                  onClick={onRefresh}
                  className="px-10 py-4 bg-white text-[#0f172a] rounded-full font-black text-xs uppercase tracking-[0.2em] hover:bg-indigo-500 hover:text-white transition-all shadow-2xl active:scale-95"
                >
                  Refresh Library
                </button>
              </>
            )}
          </div>
        )}
      </main>

      {/* 모달 렌더링 */}
      {showManage && (
        <ManageModal 
          onClose={() => setShowManage(false)} 
          onUpdate={checkOfflineStatus}
          theme={{ bg: 'bg-[#0f172a]', text: 'text-white' }}
        />
      )}

      {showSearch && (
        <ShelfSearchModal
          onClose={() => setShowSearch(false)}
          onSearch={(keyword) => setSearchKeyword(keyword)}
          initialKeyword={searchKeyword}
        />
      )}
    </div>
  );
};