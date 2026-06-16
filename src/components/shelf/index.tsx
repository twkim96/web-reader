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
import { CloudSyncStatus, FileUploader, FileUploaderHandle } from './FileUploader';
import { ImportBookModal } from './ImportBookModal';
import { useFilteredBooks, usePreparedShelfBooks } from './useFilteredBooks';
import { useOfflineBookIds } from './useOfflineBookIds';
import { useShelfPreferences } from './useShelfPreferences';
import { DEFAULT_MAX_IMPORT_FILES } from '../../lib/bookFormats';
import {
  getNextShelfVisibleCount,
  SHELF_PAGE_SIZE,
} from './progressiveBooks';

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
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>(null);
  const [isDeletingBook, setIsDeletingBook] = useState(false);
  const [visibleBookCount, setVisibleBookCount] = useState(SHELF_PAGE_SIZE);
  const [needsLoadMoreButton, setNeedsLoadMoreButton] = useState(false);

  const fileUploaderRef = useRef<FileUploaderHandle>(null);
  const shelfContentRef = useRef<HTMLElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadMorePendingRef = useRef(false);
  const visibleBookCountRef = useRef(SHELF_PAGE_SIZE);

  const theme = getThemeClasses(settings);
  const { viewMode, sortMode, toggleViewMode, toggleSortMode } = useShelfPreferences();
  const { offlineIds, refreshOfflineBookIds } = useOfflineBookIds(books);
  const preparedBooks = usePreparedShelfBooks(books, progress);
  const filteredBooks = useFilteredBooks(preparedBooks, searchKeyword, sortMode);
  const paginationInputsRef = useRef({
    books,
    isOfflineMode,
    searchKeyword,
    sortMode,
    userEmail,
    viewMode,
  });
  const previousPaginationInputs = paginationInputsRef.current;
  const paginationChanged = (
    previousPaginationInputs.books !== books
    || previousPaginationInputs.isOfflineMode !== isOfflineMode
    || previousPaginationInputs.searchKeyword !== searchKeyword
    || previousPaginationInputs.sortMode !== sortMode
    || previousPaginationInputs.userEmail !== userEmail
    || previousPaginationInputs.viewMode !== viewMode
  );
  const effectiveVisibleCount = paginationChanged ? SHELF_PAGE_SIZE : visibleBookCount;
  const visibleBooks = filteredBooks.slice(0, effectiveVisibleCount);
  const hasMoreBooks = effectiveVisibleCount < filteredBooks.length;

  const loadMoreBooks = useCallback(() => {
    if (loadMorePendingRef.current) return;
    const next = getNextShelfVisibleCount(
      visibleBookCountRef.current,
      filteredBooks.length,
    );
    if (next === visibleBookCountRef.current) return;
    loadMorePendingRef.current = true;
    visibleBookCountRef.current = next;
    setVisibleBookCount(next);
  }, [filteredBooks.length]);

  useEffect(() => {
    paginationInputsRef.current = {
      books,
      isOfflineMode,
      searchKeyword,
      sortMode,
      userEmail,
      viewMode,
    };
    visibleBookCountRef.current = SHELF_PAGE_SIZE;
    loadMorePendingRef.current = false;
    setVisibleBookCount(SHELF_PAGE_SIZE);
  }, [books, isOfflineMode, searchKeyword, sortMode, userEmail, viewMode]);

  useEffect(() => {
    visibleBookCountRef.current = visibleBookCount;
    loadMorePendingRef.current = false;
  }, [visibleBookCount]);

  useEffect(() => {
    if (!hasMoreBooks) {
      setNeedsLoadMoreButton(false);
      return;
    }
    const target = loadMoreRef.current;
    if (!target) return;

    let frameId = 0;
    const checkLoadBoundary = () => {
      frameId = 0;
      if (target.getBoundingClientRect().top <= window.innerHeight + 300) {
        loadMoreBooks();
      }
    };
    const scheduleBoundaryCheck = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(checkLoadBoundary);
    };
    window.addEventListener('scroll', scheduleBoundaryCheck, { passive: true });
    window.addEventListener('resize', scheduleBoundaryCheck);
    scheduleBoundaryCheck();

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') {
      setNeedsLoadMoreButton(true);
    } else {
      try {
        observer = new IntersectionObserver(([entry]) => {
          if (entry?.isIntersecting) loadMoreBooks();
        }, { rootMargin: '300px 0px' });
        observer.observe(target);
        setNeedsLoadMoreButton(false);
      } catch {
        setNeedsLoadMoreButton(true);
      }
    }

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleBoundaryCheck);
      window.removeEventListener('resize', scheduleBoundaryCheck);
      observer?.disconnect();
    };
  }, [hasMoreBooks, loadMoreBooks]);

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

  const handleConfirmImportFiles = useCallback((files: File[]) => {
    void fileUploaderRef.current?.importFiles(files);
  }, []);

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
    <div className={`min-h-screen ${theme.bg} ${theme.text} font-sans pb-36 transition-colors duration-300`}>
      <ShelfHeader 
        shelfContentRef={shelfContentRef}
        isOfflineMode={isOfflineMode}
        isGuest={isGuest}
        syncStatus={syncStatus}
        onCancelSync={() => fileUploaderRef.current?.cancelUpload()}
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
        ref={fileUploaderRef}
        googleToken={googleToken}
        isOfflineMode={isOfflineMode}
        onRefresh={onRefresh}
        onLocalBookImported={onLocalBookImported}
        setSyncStatus={setSyncStatus}
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
            <span className="text-xs">
              {visibleBooks.length}개 표시
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

      <main ref={shelfContentRef} className="max-w-7xl mx-auto px-6 pt-5 pb-8">
        {filteredBooks.length > 0 ? (
          <div className={`grid ${viewMode === 'grid' ? 'grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'grid-cols-1 gap-0'}`}>
            {visibleBooks.map((book) => (
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

      {hasMoreBooks && (
        <div ref={loadMoreRef} className="max-w-7xl mx-auto px-6 pb-8 text-center">
          {needsLoadMoreButton && (
            <button
              type="button"
              onClick={loadMoreBooks}
              className="rounded-full bg-accent-500 px-5 py-2 text-sm font-bold text-white"
            >
              더 보기
            </button>
          )}
        </div>
      )}

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
          books={preparedBooks}
          sortMode={sortMode}
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
        <ImportBookModal
          theme={theme}
          isOfflineMode={isOfflineMode}
          isGuest={isGuest}
          maxFiles={DEFAULT_MAX_IMPORT_FILES}
          onClose={() => setShowImportConfirm(false)}
          onConfirm={handleConfirmImportFiles}
          onLogin={onLogin}
          onToggleCloud={onToggleCloud}
        />
      )}
    </div>
  );
};
