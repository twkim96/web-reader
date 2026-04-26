import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Book, UserProgress, ViewerSettings } from '../../types';
import { getOfflineBookIds } from '../../lib/localDB';
import { ManageModal } from '../ManageModal';
import { ShelfSearchModal } from '../ShelfSearchModal';
import { ThemeModal } from '../ThemeModal';
import { ConfirmDialog } from '../ConfirmDialog';
import { THEMES } from '../../lib/constants';

import { ShelfHeader } from './ShelfHeader';
import { BookCard } from './BookCard';
import { EmptyState } from './EmptyState';
import { FileUploader } from './FileUploader';

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
  const [showSearch, setShowSearch] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [sortMode, setSortMode] = useState<'alpha' | 'recent'>('recent');
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [pendingDeleteProgressId, setPendingDeleteProgressId] = useState<string | null>(null);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  useEffect(() => {
    const savedView = localStorage.getItem('shelf_viewMode');
    if (savedView === 'grid' || savedView === 'list') setViewMode(savedView);
    
    const savedSort = localStorage.getItem('shelf_sortMode');
    if (savedSort === 'alpha' || savedSort === 'recent') setSortMode(savedSort);
  }, []);

  const handleSetViewMode = () => {
    const mode = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(mode);
    localStorage.setItem('shelf_viewMode', mode);
  };

  const handleSetSortMode = () => {
    const mode = sortMode === 'alpha' ? 'recent' : 'alpha';
    setSortMode(mode);
    localStorage.setItem('shelf_sortMode', mode);
  };

  const stateRef = useRef({ showManage, showSearch });
  useEffect(() => {
    stateRef.current = { showManage, showSearch };
  }, [showManage, showSearch]);

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

  // NFD(MacOS) / NFC 유니코드 정규화 및 공백/확장자 제거를 통한 검색 정확도 향상 (메모이제이션 적용)
  const filteredBooks = useMemo(() => {
    return books.filter(book => {
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
          // 최근 추가된 파일이 상단에 오도록 기본 정렬(원래 배열 순서 유지 등)을 반전시킵니다.
          return books.indexOf(a) - books.indexOf(b); 
        }
        return pB - pA;
      }
      return 0;
    });
  }, [books, searchKeyword, sortMode, progress]);

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} font-sans pb-20 transition-colors duration-300`}>
      <ShelfHeader 
        theme={theme}
        isOfflineMode={isOfflineMode}
        isGuest={isGuest}
        isSyncing={isSyncing}
        userEmail={userEmail}
        searchKeyword={searchKeyword}
        sortMode={sortMode}
        viewMode={viewMode}
        onToggleCloud={onToggleCloud}
        onLogin={onLogin}
        onLogout={onLogout}
        setShowSearch={setShowSearch}
        onToggleSortMode={handleSetSortMode}
        onToggleViewMode={handleSetViewMode}
        setShowThemeModal={setShowThemeModal}
        setShowManage={setShowManage}
        setShowImportConfirm={setShowImportConfirm}
      />

      <FileUploader 
        googleToken={googleToken}
        isOfflineMode={isOfflineMode}
        onRefresh={onRefresh}
        onLocalBookImported={onLocalBookImported}
        fileInputRef={fileInputRef}
        setIsSyncing={setIsSyncing}
      />

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
            {filteredBooks.map((book) => (
              <BookCard 
                key={book.id}
                book={book}
                progress={progress[book.id]}
                isDownloaded={isOfflineMode || offlineIds.has(book.id)}
                viewMode={viewMode}
                theme={theme}
                onOpen={onOpen}
                onDeleteProgress={() => setPendingDeleteProgressId(book.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState 
            searchKeyword={searchKeyword}
            isOfflineMode={isOfflineMode}
            isGuest={isGuest}
            theme={theme}
            onClearSearch={() => setSearchKeyword('')}
            onToggleCloud={onToggleCloud}
            onShowImportConfirm={() => setShowImportConfirm(true)}
            onLogin={onLogin}
            onRefresh={onRefresh}
          />
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
