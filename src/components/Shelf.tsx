import React, { useState, useEffect, useRef } from 'react';
import { 
  findFolderId, 
  createFolder, 
  uploadFile 
} from '../lib/googleDrive';
import { Book, UserProgress, ViewerSettings } from '../types';
import { getOfflineBookIds, saveBookToLocal } from '../lib/localDB';
import { ManageModal } from './ManageModal';
import { ShelfSearchModal } from './ShelfSearchModal';
import { ThemeModal } from './ThemeModal';
import { ConfirmDialog } from './ConfirmDialog';
import { THEMES } from '../lib/constants';
import { 
  Library, 
  Search, 
  BookOpen, 
  LogOut,
  LogIn,
  HardDrive,
  CheckCircle2,
  XCircle,
  FolderPlus,
  WifiOff,
  User as UserIcon,
  LayoutGrid,
  List,
  ArrowDownAZ,
  Clock,
  Eraser,
  Palette,
  Menu,
  X,
  FilePlus,
  CloudLightning
} from 'lucide-react';

interface ShelfProps {
  books: Book[];
  progress: Record<string, UserProgress>;
  googleToken: string | null;
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onOpen: (book: Book) => void;
  onRefresh: () => void;
  onLogout: () => void;
  onLogin: () => void; 
  isRefreshing: boolean;
  userEmail: string;
  isOfflineMode: boolean; 
  isGuest: boolean;
  onToggleCloud: () => void; 
  onDeleteProgress?: (bookId: string) => void; 
  onLocalBookImported?: () => void;
}

export const Shelf: React.FC<ShelfProps> = ({ 
  books, 
  progress, 
  googleToken,
  onOpen, 
  onRefresh,
  onLogout,
  onLogin,
  isRefreshing, 
  userEmail,
  isOfflineMode,
  isGuest,
  onToggleCloud,
  onDeleteProgress,
  settings,
  onUpdateSettings,
  onLocalBookImported
}) => {
  const [offlineIds, setOfflineIds] = useState<Set<string>>(new Set());
  const [showManage, setShowManage] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortMode, setSortMode] = useState<'alpha' | 'recent'>('recent');
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [pendingDeleteProgressId, setPendingDeleteProgressId] = useState<string | null>(null);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  useEffect(() => {
    const savedView = localStorage.getItem('shelf_viewMode');
    if (savedView === 'grid' || savedView === 'list') setViewMode(savedView);
    
    const savedSort = localStorage.getItem('shelf_sortMode');
    if (savedSort === 'alpha' || savedSort === 'recent') setSortMode(savedSort);
  }, []);

  const handleSetViewMode = (mode: 'grid' | 'list') => {
    setViewMode(mode);
    localStorage.setItem('shelf_viewMode', mode);
  };

  const handleSetSortMode = (mode: 'alpha' | 'recent') => {
    setSortMode(mode);
    localStorage.setItem('shelf_sortMode', mode);
  };

  const getSortIcon = () => {
    if (sortMode === 'alpha') return <ArrowDownAZ size={20} />;
    return <Clock size={20} />;
  };

  const getSortTitle = () => {
    if (sortMode === 'alpha') return "가나다순";
    return "최근에 읽은 순";
  };

  const stateRef = useRef({ showManage, showSearch });
  useEffect(() => {
    stateRef.current = { showManage, showSearch };
  }, [showManage, showSearch]);

  // 모바일 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!showMobileMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showMobileMenu]);

  /**
   * [Refactored] 선택된 파일을 구글 드라이브에 동기화합니다.
   */
  const syncFileToDrive = async (fileName: string, content: ArrayBuffer) => {
    if (!googleToken || isOfflineMode) return;

    try {
      setIsSyncing(true);
      const targetFolderName = "web viewer";
      
      let folderId = await findFolderId(targetFolderName, googleToken);
      if (!folderId) {
        folderId = await createFolder(targetFolderName, googleToken);
      }

      if (folderId) {
        await uploadFile(fileName, content, folderId, googleToken);
        onRefresh(); // 목록 갱신
      } else {
        throw new Error('폴더를 생성하거나 찾을 수 없습니다.');
      }
    } catch (error: any) {
      console.error('Sync failed:', error);
      alert(`클라우드 동기화 실패: ${error.message || '알 수 없는 오류'}\n(파일은 기기에 로컬로 저장되었습니다.)`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as ArrayBuffer;
      if (!content) return;

      // 1. 로컬 저장 (IndexedDB)
      const book: Book = {
        id: file.name,
        name: file.name,
        mimeType: file.type || 'text/plain',
      };
      
      await saveBookToLocal(book, content);
      
      // 2. 구글 드라이브 동기화 (권한 체크 및 실행)
      if (!isOfflineMode) {
        if (googleToken) {
          await syncFileToDrive(file.name, content);
        } else {
          alert('구글 드라이브 권한이 없습니다. 로그아웃 후 다시 로그인하여 권한을 허용해 주세요.');
        }
      }
      
      if (onLocalBookImported) {
        onLocalBookImported();
      }
    };
    reader.readAsArrayBuffer(file);
  };

  useEffect(() => {
    window.history.pushState({ panel: 'shelf' }, '', '');
    const handlePopState = (event: PopStateEvent) => {
      const { showManage, showSearch } = stateRef.current;
      if (showManage || showSearch) {
        if (showManage) setShowManage(false);
        if (showSearch) setShowSearch(false);
        window.history.pushState({ panel: 'shelf' }, '', '');
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
    // Firestore Timestamp or JS Date or Number
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    if (isNaN(date.getTime())) return 'Ready to Start';
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    });
  };

  // NFD(MacOS) / NFC 유니코드 정규화 및 공백/확장자 제거를 통한 검색 정확도 향상
  const filteredBooks = books.filter(book => {
    if (!book.name) return false;
    const normalizedBookName = book.name.normalize('NFC').replace('.txt', '').replace(/\s+/g, '').toLowerCase();
    const normalizedKeyword = searchKeyword.normalize('NFC').replace(/\s+/g, '').toLowerCase();
    return normalizedBookName.includes(normalizedKeyword);
  }).sort((a, b) => {
    if (sortMode === 'alpha') {
      return a.name.localeCompare(b.name);
    } else if (sortMode === 'recent') {
      const getMs = (ts: any) => {
        if (!ts) return 0;
        const d = ts.toDate ? ts.toDate() : new Date(ts);
        return isNaN(d.getTime()) ? 0 : d.getTime();
      };
      const pA = getMs(progress[a.id]?.lastRead);
      const pB = getMs(progress[b.id]?.lastRead);
      if (pA === 0 && pB === 0) {
        return books.indexOf(b) - books.indexOf(a); 
      }
      return pB - pA;
    }
    return 0;
  });

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} font-sans pb-20 transition-colors duration-300`}>
      {/* 상단 헤더 */}
      <header className={`sticky top-0 z-40 ${theme.bg}/80 backdrop-blur-md border-b ${theme.border} px-6 py-6 transition-colors duration-300`}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* 연결/해제 토글 버튼 */}
            <button 
              onClick={isGuest ? onLogin : onToggleCloud}
              className={`p-3 rounded-2xl shadow-lg transition-all active:scale-90 group relative ${
                isOfflineMode 
                  ? 'bg-slate-700 shadow-none hover:bg-slate-600' 
                  : 'bg-accent-600 shadow-accent-500/20 hover:bg-accent-500'
              }`}
              title={isOfflineMode ? "Connect to Cloud" : "Disconnect Cloud"}
            >
              {isOfflineMode ? (
                <WifiOff className="text-white group-hover:text-accent-300 transition-colors" size={24} />
              ) : (
                <Library className="text-white" size={24} />
              )}
            </button>

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg md:text-xl font-black tracking-tight uppercase italic whitespace-nowrap">
                  {isGuest ? 'Guest Library' : (isOfflineMode ? 'Local Library' : 'Cloud Library')}
                </h1>
                {isSyncing && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-500/10 border border-accent-500/20 rounded-xl text-accent-500 animate-in fade-in zoom-in duration-300">
                    <CloudLightning size={14} className="animate-bounce" />
                    <span className="text-[10px] font-black uppercase tracking-[0.1em] hidden sm:inline">Syncing to Cloud</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] opacity-60 font-bold uppercase tracking-widest">
                {isGuest && <UserIcon size={10} />}
                <span>{userEmail}</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2" ref={mobileMenuRef}>
            {/* 1. Search (돋보기) */}
            <button 
              onClick={() => setShowSearch(true)}
              className={`p-4 rounded-2xl border transition-all active:scale-90 ${
                searchKeyword 
                  ? 'bg-accent-600 border-accent-500 text-white shadow-lg shadow-accent-500/20' 
                  : `${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100`
              }`}
              title="Search Books"
            >
              <Search size={20} />
            </button>

            {/* Mobile Menu Toggle (Hamburger) */}
            <button
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className={`md:hidden p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
            >
              {showMobileMenu ? <X size={20} /> : <Menu size={20} />}
            </button>

            {/* Desktop Actions / Mobile Dropdown Container */}
            <div className={`
              absolute top-[88px] right-6 p-4 rounded-3xl border shadow-2xl flex flex-col gap-2 
              md:static md:p-0 md:bg-transparent md:border-none md:shadow-none md:flex-row md:flex
              ${theme.bg} ${theme.border}
              ${showMobileMenu ? 'animate-in fade-in slide-in-from-top-4 flex' : 'hidden'}
            `}>

            {/* Local Import (파일선택) */}
            <button
              onClick={() => setShowImportConfirm(true)}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90 text-accent-500`}
              title="Add Local Book"
            >
              <FilePlus size={20} />
            </button>
            <input 
              type="file" 
              accept=".txt" 
              ref={fileInputRef} 
              style={{ display: 'none' }} 
              onChange={handleFileUpload} 
            />

            {/* 2. Sort (정렬) */}
            <button
              onClick={() => handleSetSortMode(sortMode === 'alpha' ? 'recent' : 'alpha')}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title={getSortTitle()}
            >
              <div className="flex items-center justify-center relative">
                {getSortIcon()}
                <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-accent-500 text-white rounded-sm px-0.5 pointer-events-none">
                  {sortMode === 'alpha' ? 'A' : 'R'}
                </span>
              </div>
            </button>

            {/* 3. View Mode (목록) */}
            <button
              onClick={() => handleSetViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
            >
              {viewMode === 'grid' ? <List size={20} /> : <LayoutGrid size={20} />}
            </button>

            {/* 4. Theme (테마) */}
            <button
              onClick={() => setShowThemeModal(true)}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title="Change Theme"
            >
              <Palette size={20} />
            </button>

            {/* 5. Manage (저장) */}
            <button 
              onClick={() => setShowManage(true)}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title="Manage Offline Books"
            >
              <HardDrive size={20} />
            </button>

            {/* 6. Logout (로그아웃) */}
            {isGuest ? (
              <button 
                onClick={onLogin}
                className="p-4 rounded-2xl bg-accent-500/10 border border-accent-500/20 text-accent-400 hover:bg-accent-500 hover:text-white transition-all active:scale-90"
                title="Sign In"
              >
                <LogIn size={20} />
              </button>
            ) : (
              <button 
                onClick={onLogout}
                className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all active:scale-90"
                title="Sign Out"
              >
                <LogOut size={20} />
              </button>
            )}
            </div>
          </div>
        </div>
      </header>

      {searchKeyword && (
        <div className="max-w-7xl mx-auto px-6 pt-4 pb-0">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="text-accent-400 font-bold">"{searchKeyword}"</span>
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

      <main className="max-w-7xl mx-auto px-6 py-8">
        {filteredBooks.length > 0 ? (
          <div className={`grid gap-8 ${viewMode === 'grid' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1'}`}>
            {filteredBooks.map((book) => {
              const bookProgress = progress[book.id];
              // 게스트/오프라인 모드면 이미 다운로드된 것들임
              const isDownloaded = isOfflineMode || offlineIds.has(book.id);

              if (viewMode === 'list') {
                return (
                  <div 
                    key={book.id}
                    onClick={() => onOpen(book)}
                    className={`group flex items-center ${theme.secondary} border ${theme.border} rounded-3xl p-4 sm:p-5 cursor-pointer hover:border-accent-500/50 transition-all duration-300`}
                  >
                    <div className="w-12 h-12 bg-accent-600 rounded-xl flex items-center justify-center shrink-0 shadow-lg group-hover:scale-105 transition-transform duration-300 mr-4">
                      <BookOpen className="text-white" size={20} />
                    </div>
                    
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2">
                        <h3 className="text-base sm:text-lg font-bold truncate group-hover:text-accent-500 transition-colors">
                          {book.name.replace('.txt', '')}
                        </h3>
                        {isDownloaded && (
                          <CheckCircle2 size={16} className="text-green-400 shrink-0" strokeWidth={3} />
                        )}
                      </div>
                      <div className="text-[10px] text-slate-500 font-bold mt-1 uppercase tracking-widest truncate">
                        {bookProgress?.lastRead ? formatDate(bookProgress.lastRead) : 'Ready to Start'}
                      </div>
                    </div>

                    <div className="w-20 sm:w-32 shrink-0 flex flex-col justify-center">
                      <div className="flex justify-end mb-1.5 items-center gap-1.5">
                        {(bookProgress?.progressPercent || 0) > 0 && onDeleteProgress && (
                          <button 
                            onClick={(e) => {
                              e.stopPropagation();
                              setPendingDeleteProgressId(book.id);
                            }}
                            className="text-slate-500 hover:text-red-400 hover:bg-white/5 rounded-full p-1 transition-colors"
                            title="Delete Progress"
                          >
                            <Eraser size={12} strokeWidth={3} />
                          </button>
                        )}
                        <span className="text-xs font-black text-accent-400">
                          {bookProgress?.progressPercent?.toFixed(1) || '0.0'}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-accent-500 rounded-full transition-all duration-1000 ease-out"
                          style={{ width: `${bookProgress?.progressPercent || 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <div 
                  key={book.id}
                  onClick={() => onOpen(book)}
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
                        {book.name.replace('.txt', '')}
                      </h3>
                      <p className="text-xs text-slate-500 font-bold mt-2 uppercase tracking-widest">Text Document</p>
                    </div>

                    <div className="space-y-3">
                      <div className="flex justify-between items-end">
                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-tighter">
                          {bookProgress?.lastRead ? formatDate(bookProgress.lastRead) : 'Ready to Start'}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {(bookProgress?.progressPercent || 0) > 0 && onDeleteProgress && (
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setPendingDeleteProgressId(book.id);
                              }}
                              className="text-slate-500 hover:text-red-400 hover:bg-white/5 rounded-full p-1 transition-colors"
                              title="Delete Progress"
                            >
                              <Eraser size={12} strokeWidth={3} />
                            </button>
                          )}
                          <span className="text-xs font-black text-accent-400">{bookProgress?.progressPercent?.toFixed(1) || '0.0'}%</span>
                        </div>
                      </div>
                      <div className="h-1.5 w-full bg-black/30 rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-accent-500 rounded-full transition-all duration-1000 ease-out"
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
          <div className={`flex flex-col items-center justify-center py-32 text-center space-y-8 ${theme.secondary} rounded-[3.5rem] border ${theme.border} backdrop-blur-sm`}>
            {searchKeyword ? (
              <>
                <div className={`p-8 ${theme.secondary} rounded-[2rem] opacity-60`}>
                  <XCircle size={64} />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-bold">검색 결과가 없습니다</h3>
                  <p className="opacity-60 text-sm">"{searchKeyword}"</p>
                </div>
                <button onClick={() => setSearchKeyword('')} className="px-8 py-3 bg-accent-600 text-white rounded-full font-bold text-xs uppercase hover:bg-accent-500 transition-all">전체 목록 보기</button>
              </>
            ) : (
              <>
                <div className={`p-8 rounded-[2rem] shadow-inner ${isOfflineMode ? 'bg-slate-700/50 text-slate-400' : 'bg-accent-600/20 text-accent-400'}`}>
                  {isOfflineMode ? <WifiOff size={64} /> : <FolderPlus size={64} />}
                </div>
                
                <div className="space-y-4 max-w-sm">
                  {isOfflineMode ? (
                    <>
                      <h3 className="text-2xl font-black italic uppercase tracking-tighter">
                        {isGuest ? 'Guest Library Empty' : 'Local Library Empty'}
                      </h3>
                      <div className="flex flex-col gap-3 items-center w-full mt-2">
                        {/* [New] 로그인 상태인데 클라우드 미연결인 경우, 연결 유도 버튼 추가 */}
                        {!isGuest && isOfflineMode && (
                          <button 
                            onClick={onToggleCloud} 
                            className="w-full max-w-[240px] py-4 bg-accent-600 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500 transition-all shadow-xl shadow-accent-500/20 active:scale-95 flex items-center justify-center gap-2"
                          >
                            <Library size={16} />
                            <span>Cloud Library 연결하기</span>
                          </button>
                        )}

                        <button 
                          onClick={() => setShowImportConfirm(true)} 
                          className={`w-full max-w-[240px] py-4 rounded-full font-black text-[11px] uppercase tracking-widest transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2 ${
                            !isGuest && isOfflineMode 
                              ? `bg-white/5 border-2 ${theme.border} hover:bg-white/10 opacity-70` 
                              : "bg-accent-600 text-white hover:bg-accent-500"
                          }`}
                        >
                          <FilePlus size={16} />
                          <span>도서 직접 추가하기</span>
                        </button>

                        {isGuest && (
                          <button 
                            onClick={onLogin} 
                            className="text-[10px] font-bold text-accent-500/60 hover:text-accent-500 uppercase tracking-widest transition-colors"
                          >
                            또는 클라우드 계정으로 로그인하기
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <h3 className="text-2xl font-black italic uppercase tracking-tighter">No Books Found</h3>
                      <p className="opacity-60 text-sm leading-relaxed font-medium">
                        구글 드라이브에 <span className="text-accent-500 font-black">"web viewer"</span> 폴더를 생성하고, 읽고 싶은 <span className="text-accent-500 font-black">.txt</span> 파일을 업로드해 주세요.
                      </p>
                      <div className="flex flex-col gap-3 items-center w-full mt-2">
                        <button 
                          onClick={() => setShowImportConfirm(true)} 
                          className="w-full max-w-[240px] py-4 bg-slate-700 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-slate-600 transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                        >
                          <FilePlus size={16} />
                          <span>도서 직접 추가하기</span>
                        </button>
                        <a 
                          href="https://drive.google.com/" 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className={`w-full max-w-[240px] py-4 border-2 border-accent-500/30 bg-accent-500/5 ${theme.text} rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500/10 transition-all flex items-center justify-center gap-3 active:scale-95 shadow-sm`}
                        >
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M7.74023 6L4.64023 11.38L8.60023 18.25L11.7002 12.87L7.74023 6Z" fill="#0066DA"/>
                            <path d="M21.5 13.5L15.3 13.5L12.21 18.82L15.41 24L21.5 13.5Z" fill="#0066DA" opacity="0"/>
                            <path d="M21.5002 13.5002L18.4002 18.8802L12.3002 18.8802L15.4002 13.5002L21.5002 13.5002Z" fill="#2684FF"/>
                            <path d="M12.3002 18.88L15.4002 13.5L8.60023 18.25L12.3002 18.88Z" fill="#0066DA" opacity="0"/>
                            <path d="M15.4002 13.5002L12.3002 8.12015L6.2002 8.12015L9.3002 13.5002L15.4002 13.5002Z" fill="#FFBC00"/>
                            <path d="M15.4002 13.5002L12.3002 8.12015L11.7002 12.87L15.4002 13.5002Z" fill="#0066DA" opacity="0"/>
                            <path d="M9.30023 13.5002L6.19022 18.8802L3.10022 13.5001L6.20023 8.12012L9.30023 13.5002Z" fill="#00AC47"/>
                            <path d="M6.2002 8.12012L9.3002 13.5002L12.3002 8.12012L9.2002 2.74012L3.1002 2.74012L6.2002 8.12012Z" fill="#EA4335" opacity="0"/>
                            <path d="M15.4002 2.74011L9.2002 2.74011L6.10022 8.12011L12.3002 8.12011L15.4002 2.74011Z" fill="#00AC47" opacity="0"/>
                            <path d="M9.3002 2.74011L3.2002 2.74011L6.2002 8.12011L9.3002 2.74011Z" fill="#0066DA" opacity="0"/>
                            <path d="M12.3002 8.12011L9.2002 2.74011L15.4002 2.74011L18.5002 8.12011L12.3002 8.12011Z" fill="#00AC47" opacity="0"/>
                            <path d="M15.41 12.87L18.51 8.12L12.41 8.12L9.31006 13.5L15.41 12.87Z" fill="#0066DA" opacity="0"/>
                            <path d="M18.5 8.12011L15.4 2.74011L9.3 2.74011L12.4 8.12011L18.5 8.12011Z" fill="#0066DA" opacity="0"/>
                          </svg>
                          <span>Open Google Drive</span>
                        </a>
                        <button onClick={onRefresh} className="w-full max-w-[240px] py-4 bg-accent-600 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500 transition-all shadow-xl shadow-accent-500/20 active:scale-95">
                          Refresh Library
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {showManage && (
        <ManageModal 
          onClose={() => setShowManage(false)} 
          onUpdate={checkOfflineStatus}
          theme={theme}
        />
      )}

      {showSearch && (
        <ShelfSearchModal
          onClose={() => setShowSearch(false)}
          onSearch={(keyword) => setSearchKeyword(keyword)}
          initialKeyword={searchKeyword}
          theme={theme}
          books={books}
          onOpen={onOpen}
          progress={progress}
          offlineIds={offlineIds}
          isOfflineMode={isOfflineMode}
        />
      )}

      {showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => setShowThemeModal(false)}
          theme={theme}
          onSelectTheme={(newTheme) => onUpdateSettings({ theme: newTheme })}
        />
      )}

      {pendingDeleteProgressId && onDeleteProgress && (
        <ConfirmDialog
          message="읽은 내역을 삭제하시겠습니까?"
          subMessage="해당 도서의 진행률이 초기화됩니다."
          confirmLabel="삭제"
          theme={theme}
          onConfirm={() => { onDeleteProgress(pendingDeleteProgressId); setPendingDeleteProgressId(null); }}
          onCancel={() => setPendingDeleteProgressId(null)}
        />
      )}

      {showImportConfirm && (
        <ConfirmDialog
          message="도서를 라이브러리에 추가하시겠습니까?"
          subMessage={isOfflineMode 
            ? (
              <span>
                선택한 도서가 내 기기에 저장됩니다. 원활한 동기화를 위해{" "}
                <button 
                  onClick={(e) => { 
                    e.stopPropagation(); 
                    setShowImportConfirm(false); 
                    onToggleCloud(); 
                  }}
                  className="text-accent-500 underline decoration-accent-500/50 underline-offset-2 hover:text-accent-400 font-black cursor-pointer"
                >
                  {isGuest ? "클라우드 로그인" : "클라우드 서비스 연결"}
                </button>
                {" "}후 추가하는 것을 추천합니다.
              </span>
            )
            : "선택한 도서가 내 기기에 저장되며, 구글 드라이브의 'web viewer' 폴더로 자동 업로드됩니다."
          }
          confirmLabel="추가"
          variant="info"
          theme={theme}
          onConfirm={() => { setShowImportConfirm(false); fileInputRef.current?.click(); }}
          onCancel={() => setShowImportConfirm(false)}
        />
      )}
    </div>
  );
};