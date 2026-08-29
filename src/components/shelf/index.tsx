import React, { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { Book, UserProgress, ViewerSettings } from '../../types';
import { ManageModal } from '../ManageModal';
import { ShelfSearchModal } from '../ShelfSearchModal';
import { ThemeModal } from '../ThemeModal';
import { ConfirmDialog } from '../ConfirmDialog';
import { getThemeClasses, getThemeColors } from '../../lib/themeUtils';

import { ShelfHeader } from './ShelfHeader';
import { BookCard } from './BookCard';
import { EmptyState } from './EmptyState';
import { CloudSyncStatus, FileUploader, FileUploaderHandle } from './FileUploader';
import { ImportBookModal } from './ImportBookModal';
import { BookInfoModal } from './BookInfoModal';
import { ShelfFilterModal } from './ShelfFilterModal';
import { useFilteredBooks, usePreparedShelfBooks } from './useFilteredBooks';
import { useOfflineBookIds } from './useOfflineBookIds';
import { useShelfPreferences } from './useShelfPreferences';
import { DEFAULT_MAX_IMPORT_FILES } from '../../lib/bookFormats';
import type { OwnerKey } from '../../lib/ownerIdentity';
import { usePublicBookCatalog } from '../../hooks/usePublicBookCatalog';
import {
  EMPTY_SHELF_FILTERS,
  getActiveShelfFilterCount,
  getShelfFilterKey,
  type ShelfFilters,
  type ShelfSortMode,
} from './bookUtils';
import {
  getNextShelfVisibleCount,
  SHELF_PAGE_SIZE,
} from './progressiveBooks';
import { useShelfBookCovers } from './useShelfBookCovers';
import { installSampleBooks } from '../../lib/sampleBook';

interface ShelfProps {
  books: Book[];
  ownerKey: OwnerKey;
  progress: Record<string, UserProgress>;
  googleToken: string | null;
  driveCacheKey: string | null;
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
  onDeleteLocalBookCopy?: (book: Book) => Promise<void>;
  recentlyImportedBookIds?: string[];
  onBookImported?: (book: Book, savedLocally: boolean) => void;
  isCloudTokenValid?: () => boolean;
  onCloudAuthExpired?: () => void;
  themeStyle?: React.CSSProperties;
  onShowAnnotations: () => void;
  onShowStatistics: () => void;
}

export const Shelf: React.FC<ShelfProps> = ({ 
  books, 
  ownerKey,
  progress, 
  googleToken,
  driveCacheKey,
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
  onDeleteLocalBookCopy,
  settings,
  onUpdateSettings,
  recentlyImportedBookIds = [],
  onBookImported,
  isCloudTokenValid,
  onCloudAuthExpired,
  themeStyle,
  onShowAnnotations,
  onShowStatistics,
}) => {
  const [showManage, setShowManage] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [filters, setFilters] = useState<ShelfFilters>(() => ({
    sources: [...EMPTY_SHELF_FILTERS.sources],
    genreIds: [...EMPTY_SHELF_FILTERS.genreIds],
    tagIds: [...EMPTY_SHELF_FILTERS.tagIds],
  }));
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [pendingDeleteProgressId, setPendingDeleteProgressId] = useState<string | null>(null);
  const [selectedBookInfo, setSelectedBookInfo] = useState<Book | null>(null);
  const [showImportConfirm, setShowImportConfirm] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus>(null);
  const [isDeletingBook, setIsDeletingBook] = useState(false);
  const [visibleBookCount, setVisibleBookCount] = useState(SHELF_PAGE_SIZE);
  const [needsLoadMoreButton, setNeedsLoadMoreButton] = useState(false);
  const [isAddingSampleBook, setIsAddingSampleBook] = useState(false);
  const [sampleBookFeedback, setSampleBookFeedback] = useState('');

  const fileUploaderRef = useRef<FileUploaderHandle>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const loadMorePendingRef = useRef(false);
  const visibleBookCountRef = useRef(SHELF_PAGE_SIZE);

  const theme = getThemeClasses(settings);
  const themeBackgroundColor = getThemeColors(settings).bg;
  const { viewMode, sortMode, toggleViewMode, setSortMode } = useShelfPreferences();
  const catalog = usePublicBookCatalog(books);
  const { offlineIds, refreshOfflineBookIds } = useOfflineBookIds(books);
  const preparedBooks = usePreparedShelfBooks(books, progress, catalog.booksById);
  const activeFilterCount = getActiveShelfFilterCount(filters);
  const hasActiveShelfQuery = Boolean(searchKeyword) || activeFilterCount > 0;
  const filteredBooks = useFilteredBooks(
    preparedBooks,
    searchKeyword,
    sortMode,
    recentlyImportedBookIds,
    filters,
  );
  const filterKey = getShelfFilterKey(filters);
  const catalogGeneration = catalog.snapshot
    ? `${catalog.snapshot.manifest.generation}:${catalog.snapshot.deltaGeneration ?? 'base'}`
    : catalog.state;
  const paginationInputsRef = useRef({
    books,
    isOfflineMode,
    searchKeyword,
    sortMode,
    filterKey,
    catalogGeneration,
    userEmail,
    viewMode,
  });
  const previousPaginationInputs = paginationInputsRef.current;
  const paginationChanged = (
    previousPaginationInputs.books !== books
    || previousPaginationInputs.isOfflineMode !== isOfflineMode
    || previousPaginationInputs.searchKeyword !== searchKeyword
    || previousPaginationInputs.sortMode !== sortMode
    || previousPaginationInputs.filterKey !== filterKey
    || previousPaginationInputs.catalogGeneration !== catalogGeneration
    || previousPaginationInputs.userEmail !== userEmail
    || previousPaginationInputs.viewMode !== viewMode
  );
  const effectiveVisibleCount = paginationChanged ? SHELF_PAGE_SIZE : visibleBookCount;
  const visibleBooks = useMemo(
    () => filteredBooks.slice(0, effectiveVisibleCount),
    [effectiveVisibleCount, filteredBooks],
  );
  const hasMoreBooks = effectiveVisibleCount < filteredBooks.length;
  const coverUrls = useShelfBookCovers(visibleBooks);

  const clearShelfQuery = useCallback(() => {
    setSearchKeyword('');
    setFilters({
      sources: [...EMPTY_SHELF_FILTERS.sources],
      genreIds: [...EMPTY_SHELF_FILTERS.genreIds],
      tagIds: [...EMPTY_SHELF_FILTERS.tagIds],
    });
  }, []);

  const loadMoreBooks = useCallback(() => {
    if (loadMorePendingRef.current) {
      // A prop-driven pagination reset and an IntersectionObserver callback can
      // be batched into one render. In that case the ref may already contain
      // the next page while React kept the reset count. Re-apply the committed
      // ref instead of leaving the sentinel permanently locked.
      setVisibleBookCount((current) => Math.max(
        current,
        Math.min(visibleBookCountRef.current, filteredBooks.length),
      ));
      return;
    }
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
      filterKey,
      catalogGeneration,
      userEmail,
      viewMode,
    };
    visibleBookCountRef.current = SHELF_PAGE_SIZE;
    loadMorePendingRef.current = false;
    setVisibleBookCount(SHELF_PAGE_SIZE);
  }, [books, catalogGeneration, filterKey, isOfflineMode, searchKeyword, sortMode, userEmail, viewMode]);

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
    const initialVisibleCount = effectiveVisibleCount;
    setNeedsLoadMoreButton(false);

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
    const fallbackTimerId = window.setTimeout(() => {
      if (visibleBookCountRef.current <= initialVisibleCount) {
        setNeedsLoadMoreButton(true);
      }
    }, 1_500);

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') {
      setNeedsLoadMoreButton(true);
    } else {
      try {
        observer = new IntersectionObserver(([entry]) => {
          if (entry?.isIntersecting) loadMoreBooks();
        }, { rootMargin: '300px 0px' });
        observer.observe(target);
      } catch {
        setNeedsLoadMoreButton(true);
      }
    }

    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleBoundaryCheck);
      window.removeEventListener('resize', scheduleBoundaryCheck);
      window.clearTimeout(fallbackTimerId);
      observer?.disconnect();
    };
  }, [effectiveVisibleCount, hasMoreBooks, loadMoreBooks]);

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

  const handleRequestBookInfo = useCallback((book: Book) => {
    if (!onDeleteBook) return;
    setSelectedBookInfo(book);
  }, [onDeleteBook]);

  const handleConfirmImportFiles = useCallback((files: File[]) => {
    void fileUploaderRef.current?.importFiles(files);
  }, []);

  const handleAddSampleBook = useCallback(async () => {
    if (isAddingSampleBook) return;
    setIsAddingSampleBook(true);
    setSampleBookFeedback('');
    try {
      const books = await installSampleBooks();
      books.forEach((book, index) => {
        onBookImported?.(book, index === books.length - 1);
      });
      await refreshOfflineBookIds();
    } catch (error) {
      console.error('[Shelf] Failed to install sample book:', error);
      setSampleBookFeedback('샘플 도서를 추가하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setIsAddingSampleBook(false);
    }
  }, [isAddingSampleBook, onBookImported, refreshOfflineBookIds]);

  const handleConfirmDeleteBook = useCallback(async () => {
    if (!selectedBookInfo || !onDeleteBook) return;
    setIsDeletingBook(true);
    try {
      await onDeleteBook(selectedBookInfo);
      setSelectedBookInfo(null);
    } finally {
      setIsDeletingBook(false);
    }
  }, [onDeleteBook, selectedBookInfo]);

  const handleDeleteLocalBookCopy = useCallback(async () => {
    if (!selectedBookInfo || !onDeleteLocalBookCopy) return;
    setIsDeletingBook(true);
    try {
      await onDeleteLocalBookCopy(selectedBookInfo);
      await refreshOfflineBookIds();
    } finally {
      setIsDeletingBook(false);
    }
  }, [onDeleteLocalBookCopy, refreshOfflineBookIds, selectedBookInfo]);

  const stateRef = useRef({ showManage, showSearch, showFilter, selectedBookInfo, isDeletingBook });
  useEffect(() => {
    stateRef.current = { showManage, showSearch, showFilter, selectedBookInfo, isDeletingBook };
  }, [isDeletingBook, selectedBookInfo, showFilter, showManage, showSearch]);

  useEffect(() => {
    if (window.history.state?.panel !== 'shelf') {
      window.history.pushState({ panel: 'shelf' }, '', '');
    }
    const handlePopState = () => {
      const {
        showManage,
        showSearch,
        showFilter,
        selectedBookInfo,
        isDeletingBook,
      } = stateRef.current;
      if (showManage || showSearch || showFilter || selectedBookInfo) {
        if (showManage) setShowManage(false);
        if (showSearch) setShowSearch(false);
        if (showFilter) setShowFilter(false);
        if (selectedBookInfo && !isDeletingBook) setSelectedBookInfo(null);
        window.history.pushState({ panel: 'shelf' }, '', '');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return (
    <div
      className={`min-h-screen ${theme.bg} ${theme.text} font-sans pb-36 transition-colors duration-300`}
      style={themeStyle}
    >
      <ShelfHeader 
        isOfflineMode={isOfflineMode}
        isGuest={isGuest}
        syncStatus={syncStatus}
        onCancelSync={() => fileUploaderRef.current?.cancelUpload()}
        userEmail={userEmail}
        searchKeyword={searchKeyword}
        sortMode={sortMode}
        activeFilterCount={activeFilterCount}
        viewMode={viewMode}
        dockStyle={settings.shelfDockStyle}
        onToggleCloud={onToggleCloud}
        onLogin={onLogin}
        onLogout={onLogout}
        setShowSearch={setShowSearch}
        onShowFilters={() => setShowFilter(true)}
        onToggleViewMode={toggleViewMode}
        setShowThemeModal={setShowThemeModal}
        setShowManage={setShowManage}
        setShowImportConfirm={handleShowImportConfirm}
        onShowAnnotations={onShowAnnotations}
        onShowStatistics={onShowStatistics}
      />

      <FileUploader 
        ref={fileUploaderRef}
        googleToken={googleToken}
        driveCacheKey={driveCacheKey}
        isOfflineMode={isOfflineMode}
        onRefresh={onRefresh}
        onBookImported={onBookImported}
        setSyncStatus={setSyncStatus}
        isCloudTokenValid={isCloudTokenValid}
        onCloudAuthExpired={handleCloudAuthExpired}
      />

      {hasActiveShelfQuery && (
        <div
          data-shelf-results-summary="true"
          data-shelf-active-filter-count={activeFilterCount}
          className="max-w-7xl mx-auto px-6 pt-4 pb-0"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
            {searchKeyword ? (
              <>
                <span className="text-accent-400 font-bold">&quot;{searchKeyword}&quot;</span>
                <span>검색 결과</span>
              </>
            ) : (
              <span className="text-accent-400 font-bold">필터 결과</span>
            )}
            {activeFilterCount > 0 && (
              <span
                data-shelf-active-filters="true"
                className="rounded-md bg-accent-500/10 px-2 py-0.5 text-xs font-bold text-accent-400"
              >
                필터 {activeFilterCount}개
              </span>
            )}
            <span className="bg-white/10 px-2 py-0.5 rounded-md text-xs font-bold text-white">
              {filteredBooks.length}
            </span>
            <span className="text-xs">
              {visibleBooks.length}개 표시
            </span>
            <button
              type="button"
              data-shelf-clear-filter="true"
              aria-label="검색 및 필터 초기화"
              onClick={clearShelfQuery}
              className="ml-auto whitespace-nowrap text-xs font-bold text-slate-500 hover:text-white uppercase tracking-wider"
            >
              Clear Filter
            </button>
          </div>
        </div>
      )}

      <main data-shelf-content="true" className="max-w-7xl mx-auto px-6 pt-3 pb-8">
        {filteredBooks.length > 0 ? (
          <div className={`grid ${
            viewMode === 'simple'
              ? 'grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5'
              : viewMode === 'grid'
                ? 'grid-cols-1 gap-4 sm:grid-cols-2'
                : 'grid-cols-1 gap-0'
          }`}>
            {visibleBooks.map((book) => (
              <BookCard 
                key={book.id}
                book={book}
                progress={progress[book.id]}
                isDownloaded={isOfflineMode || offlineIds.has(book.id)}
                viewMode={viewMode}
                theme={theme}
                themeBackgroundColor={themeBackgroundColor}
                catalog={catalog.booksById.get(book.id)}
                coverUrl={coverUrls.get(book.id)}
                onOpen={onOpen}
                onDeleteProgress={() => setPendingDeleteProgressId(book.id)}
                onRequestBookInfo={handleRequestBookInfo}
              />
            ))}
          </div>
        ) : (
          <EmptyState 
            searchKeyword={searchKeyword}
            activeFilterCount={activeFilterCount}
            isOfflineMode={isOfflineMode}
            isGuest={isGuest}
            theme={theme}
            onClearFilters={clearShelfQuery}
            onToggleCloud={onToggleCloud}
            onLogin={onLogin}
            onShowImportConfirm={() => handleShowImportConfirm(true)}
            onAddSampleBook={() => void handleAddSampleBook()}
            isAddingSampleBook={isAddingSampleBook}
            sampleBookFeedback={sampleBookFeedback}
          />
        )}
      </main>

      {hasMoreBooks && (
        <div ref={loadMoreRef} className="max-w-7xl mx-auto px-6 pb-8 text-center">
          {needsLoadMoreButton && (
            <button
              type="button"
              onClick={loadMoreBooks}
              className="app-control-radius-lg bg-accent-500 px-5 py-2 text-sm font-bold text-white"
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
          filters={filters}
          catalog={catalog.snapshot}
          sortMode={sortMode}
          onSelectTag={(tagId) => {
            setFilters((current) => current.tagIds.includes(tagId) ? current : ({
              ...current,
              tagIds: [...current.tagIds, tagId],
            }));
            setSearchKeyword('');
          }}
          onOpen={onOpen}
          progress={progress}
          offlineIds={offlineIds}
          isOfflineMode={isOfflineMode}
        />
      )}

      {showFilter && (
        <ShelfFilterModal
          books={preparedBooks}
          filters={filters}
          sortMode={sortMode}
          catalog={catalog.snapshot}
          catalogState={catalog.state}
          theme={theme}
          onRetryCatalog={catalog.retry}
          onApply={(nextSortMode: ShelfSortMode, nextFilters: ShelfFilters) => {
            setSortMode(nextSortMode);
            setFilters({
              sources: [...nextFilters.sources],
              genreIds: [...nextFilters.genreIds],
              tagIds: [...nextFilters.tagIds],
            });
            setShowFilter(false);
          }}
          onClose={() => setShowFilter(false)}
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

      {selectedBookInfo && onDeleteBook && (
        <BookInfoModal
          key={selectedBookInfo.id}
          book={selectedBookInfo}
          ownerKey={ownerKey}
          progress={progress[selectedBookInfo.id]}
          isDownloaded={isOfflineMode || offlineIds.has(selectedBookInfo.id)}
          isOfflineMode={isOfflineMode}
          canDeleteLocalCopy={
            !isOfflineMode
            && selectedBookInfo.source !== 'local'
            && offlineIds.has(selectedBookInfo.id)
          }
          theme={theme}
          themeBackgroundColor={themeBackgroundColor}
          catalog={catalog.booksById.get(selectedBookInfo.id)}
          catalogState={catalog.state}
          onCatalogRefresh={catalog.retry}
          isDeleting={isDeletingBook}
          onOpen={(book) => {
            if (isDeletingBook) return;
            setSelectedBookInfo(null);
            onOpen(book);
          }}
          onDelete={handleConfirmDeleteBook}
          onDeleteLocalCopy={handleDeleteLocalBookCopy}
          onClose={() => { if (!isDeletingBook) setSelectedBookInfo(null); }}
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
