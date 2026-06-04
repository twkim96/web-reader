import React, { useCallback, useState, useEffect, useRef } from 'react';
import { Book, UserProgress, ViewerSettings } from '../../types';
import { ManageModal } from '../ManageModal';
import { ShelfSearchModal } from '../ShelfSearchModal';
import { ThemeModal } from '../ThemeModal';
import { ConfirmDialog } from '../ConfirmDialog';
import { getThemeClasses } from '../../lib/themeUtils';

import { ShelfHeader } from './ShelfHeader';
import { BookCard } from './BookCard';
import { EmptyState } from './EmptyState';
import { FileUploader } from './FileUploader';
import { useFilteredBooks } from './useFilteredBooks';
import { useOfflineBookIds } from './useOfflineBookIds';
import { useShelfPreferences } from './useShelfPreferences';

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
  userEmail: string;
  isOfflineMode: boolean; 
  isGuest: boolean;
  onToggleCloud: () => void; 
  onDeleteProgress?: (bookId: string) => void; 
  onDeleteBook?: (book: Book) => Promise<void>;
  onLocalBookImported?: () => void;
  isCloudTokenValid?: () => boolean;
  onCloudAuthExpired?: () => void;
}

export const Shelf: React.FC<ShelfProps> = ({ 
  books, 
  progress, 
  googleToken,
  onOpen, 
  onRefresh,
  onLogout,
  onLogin,
  userEmail,
  isOfflineMode,
  isGuest,
  onToggleCloud,
  onDeleteProgress,
  onDeleteBook,
  settings,
  onUpdateSettings,
  onLocalBookImported,
  isCloudTokenValid,
  onCloudAuthExpired
}) => {
  const [showManage, setShowManage] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [pendingDeleteProgressId, setPendingDeleteProgressId] = useState<string | null>(null);
  const [pendingDeleteBook, setPendingDeleteBook] = useState<Book | null>(null);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isDeletingBook, setIsDeletingBook] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const theme = getThemeClasses(settings);
  const { viewMode, sortMode, toggleViewMode, toggleSortMode } = useShelfPreferences();
  const { offlineIds, refreshOfflineBookIds } = useOfflineBookIds(books);
  const filteredBooks = useFilteredBooks(books, searchKeyword, sortMode, progress);

  const handleCloudAuthExpired = useCallback(() => {
    onCloudAuthExpired?.();
  }, [onCloudAuthExpired]);

  const handleShowImportConfirm = useCallback((show: boolean) => {
    if (show && !isOfflineMode && isCloudTokenValid?.() === false) {
      handleCloudAuthExpired();
      return;
    }
    setShowImportConfirm(show);
  }, [handleCloudAuthExpired, isCloudTokenValid, isOfflineMode]);

  const handleRequestDeleteBook = useCallback((book: Book) => {
    if (!onDeleteBook) return;
    setPendingDeleteBook(book);
  }, [onDeleteBook]);

  const handleConfirmDeleteBook = useCallback(async () => {
    if (!pendingDeleteBook || !onDeleteBook) return;
    setIsDeletingBook(true);
    try {
      await onDeleteBook(pendingDeleteBook);
      setPendingDeleteBook(null);
    } finally {
      setIsDeletingBook(false);
    }
  }, [onDeleteBook, pendingDeleteBook]);

  const stateRef = useRef({ showManage, showSearch });
  useEffect(() => {
    stateRef.current = { showManage, showSearch };
  }, [showManage, showSearch]);

  useEffect(() => {
    window.history.pushState({ panel: 'shelf' }, '', '');
    const handlePopState = () => {
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
        onToggleSortMode={toggleSortMode}
        onToggleViewMode={toggleViewMode}
        setShowThemeModal={setShowThemeModal}
        setShowManage={setShowManage}
        setShowImportConfirm={handleShowImportConfirm}
      />

      <FileUploader 
        googleToken={googleToken}
        isOfflineMode={isOfflineMode}
        onRefresh={onRefresh}
        onLocalBookImported={onLocalBookImported}
        fileInputRef={fileInputRef}
        setIsSyncing={setIsSyncing}
        isCloudTokenValid={isCloudTokenValid}
        onCloudAuthExpired={handleCloudAuthExpired}
      />

      {searchKeyword && (
        <div className="max-w-7xl mx-auto px-6 pt-4 pb-0">
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="text-accent-400 font-bold">&quot;{searchKeyword}&quot;</span>
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
                onRequestDeleteBook={handleRequestDeleteBook}
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
            onShowImportConfirm={() => handleShowImportConfirm(true)}
            onLogin={onLogin}
            onRefresh={onRefresh}
          />
        )}
      </main>

      {showManage && (
        <ManageModal 
          onClose={() => setShowManage(false)} 
          onUpdate={refreshOfflineBookIds}
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

      {pendingDeleteBook && onDeleteBook && (
        <ConfirmDialog
          message="이 도서를 삭제하시겠습니까?"
          subMessage={isOfflineMode || pendingDeleteBook.source === 'local'
            ? "로컬 저장소에서 영구 삭제됩니다."
            : "구글 드라이브에서 삭제됩니다. 기기에 저장된 사본도 함께 삭제됩니다."
          }
          confirmLabel={isDeletingBook ? "삭제 중..." : "삭제"}
          theme={theme}
          onConfirm={() => { if (!isDeletingBook) void handleConfirmDeleteBook(); }}
          onCancel={() => { if (!isDeletingBook) setPendingDeleteBook(null); }}
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
                    if (isGuest) onLogin();
                    else onToggleCloud();
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
