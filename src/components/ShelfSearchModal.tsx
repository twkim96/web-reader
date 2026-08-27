import React, { useDeferredValue, useMemo, useRef, useState } from 'react';
import { Search, X, BookOpen, ChevronRight, CheckCircle2, Hash } from 'lucide-react';
import { Book, UserProgress } from '../types';
import type { PublicBookCatalogSnapshot } from '../lib/publicBookCatalog';
import {
  filterAndSortPreparedBooks,
  getDisplayBookTitle,
  getProgressTime,
  matchesShelfFilters,
  type PreparedShelfBook,
  type ShelfFilters,
  type ShelfSortMode,
  type ShelfTheme,
} from './shelf/bookUtils';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import {
  normalizeShelfTagQuery,
  searchShelfCatalogTags,
} from './shelf/tagSearch';

interface ShelfSearchModalProps {
  onClose: () => void;
  onSearch: (keyword: string) => void;
  onSelectTag: (tagId: number) => void;
  initialKeyword: string;
  theme: ShelfTheme;
  books: PreparedShelfBook[];
  filters: ShelfFilters;
  catalog: PublicBookCatalogSnapshot | null;
  sortMode: ShelfSortMode;
  onOpen: (book: Book) => void;
  progress: Record<string, UserProgress>;
  offlineIds: Set<string>;
  isOfflineMode: boolean;
}

export const ShelfSearchModal: React.FC<ShelfSearchModalProps> = ({
  onClose,
  onSearch,
  onSelectTag,
  initialKeyword,
  theme,
  books,
  filters,
  catalog,
  onOpen,
  progress,
  offlineIds,
  isOfflineMode,
  sortMode,
}) => {
  useBodyScrollLock();
  const [keyword, setKeyword] = useState(initialKeyword);
  const composingRef = useRef(false);
  const deferredKeyword = useDeferredValue(keyword);
  const trimmed = deferredKeyword.trim();
  const tagMode = trimmed.startsWith('#');
  const tagQuery = tagMode ? normalizeShelfTagQuery(trimmed.slice(1)) : '';

  const preparedById = useMemo(() => new Map(
    books.map((prepared) => [prepared.book.id, prepared]),
  ), [books]);
  const matchingTags = useMemo(() => {
    if (!tagMode || !catalog) return [];
    return searchShelfCatalogTags(books, catalog.tags.values(), tagQuery, 8);
  }, [books, catalog, tagMode, tagQuery]);
  const matchingTagIds = useMemo(
    () => new Set(matchingTags.map((tag) => tag.id)),
    [matchingTags],
  );
  const filteredBooks = useMemo(() => {
    if (!trimmed) return [];
    if (!tagMode) {
      return filterAndSortPreparedBooks(books, trimmed, sortMode, [], filters).slice(0, 5);
    }
    if (matchingTagIds.size === 0) return [];
    const candidates = books.filter((prepared) => (
      matchesShelfFilters(prepared, filters)
      && prepared.catalog?.record.tagIds.some((tagId) => matchingTagIds.has(tagId))
    ));
    return filterAndSortPreparedBooks(candidates, '', sortMode).slice(0, 5);
  }, [books, filters, matchingTagIds, sortMode, tagMode, trimmed]);

  const selectTag = (tagId: number) => {
    onSelectTag(tagId);
    onSearch('');
    onClose();
  };
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (composingRef.current) return;
    if (tagMode) {
      if (matchingTags[0]) selectTag(matchingTags[0].id);
      return;
    }
    onSearch(keyword);
    onClose();
  };
  const formatDate = (timestamp: unknown) => {
    const time = getProgressTime(timestamp);
    if (!time) return null;
    return new Date(time).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center bg-black/40 p-4 pt-[15vh] backdrop-blur-sm" onClick={onClose}>
      <div
        data-shelf-search-modal="true"
        className={`app-panel-radius app-search-modal-radius app-radius-exempt flex max-h-[72dvh] w-full max-w-2xl flex-col overflow-hidden border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl`}
        onClick={(event) => event.stopPropagation()}
      >
        <form
          data-shelf-search-input-row="true"
          onSubmit={handleSubmit}
          className="relative flex h-[3.75rem] shrink-0 items-center px-1 sm:h-[4.25rem] sm:px-2"
        >
          <div className="pl-3 pr-1.5 sm:pl-5 sm:pr-2">
            {tagMode ? <Hash className="size-5 text-accent-500 sm:size-6" /> : <Search className="size-5 opacity-50 sm:size-6" />}
          </div>
          <input
            data-shelf-search-input="true"
            autoFocus
            type="text"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            placeholder="도서 이름 또는 #태그 검색..."
            className="h-full min-w-0 w-full bg-transparent pr-2 text-base font-bold focus:outline-none placeholder:opacity-30 sm:pr-4 sm:text-lg"
          />
          {keyword && (
            <button
              type="button"
              onClick={() => { setKeyword(''); onSearch(''); }}
              aria-label="도서 검색어 지우기"
              className="mr-0.5 flex size-11 shrink-0 items-center justify-center rounded-full opacity-50 transition-all hover:bg-black/10 hover:opacity-100 sm:mr-1"
            >
              <X size={20} />
            </button>
          )}
        </form>

        {trimmed && (
          <div className={`min-h-0 overflow-y-auto border-t ${theme.border}`}>
            {tagMode && matchingTags.length > 0 && (
              <section data-shelf-tag-search-results="true" className={`border-b ${theme.border} px-4 py-3 sm:px-6`}>
                <h3 className="text-[10px] font-black uppercase tracking-widest text-accent-500">태그</h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {matchingTags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      data-shelf-tag-search-result={tag.id}
                      onClick={() => selectTag(tag.id)}
                      className="app-tag-radius bg-accent-500/12 px-3 py-1.5 text-xs font-black text-accent-500 hover:bg-accent-500 hover:text-white"
                    >
                      #{tag.label}
                      {tag.shelfTitleCount > 0 && (
                        <> <span className="opacity-55">{tag.shelfTitleCount.toLocaleString('ko-KR')}권</span></>
                      )}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {filteredBooks.length > 0 ? (
              <div className="py-2">
                <div className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-accent-500">
                  {tagMode ? '이 태그를 사용하는 도서' : 'Books'}
                </div>
                {filteredBooks.map((book) => {
                  const bookProgress = progress[book.id];
                  const isDownloaded = isOfflineMode || offlineIds.has(book.id);
                  const lastDate = formatDate(bookProgress?.lastRead);
                  const percent = bookProgress?.progressPercent;
                  const prepared = preparedById.get(book.id);
                  const tagPreview = prepared?.catalog?.tags
                    .filter((tag) => tag.label !== prepared.catalog?.genreLabel)
                    .slice(0, 2) ?? [];
                  return (
                    <button
                      key={book.id}
                      type="button"
                      onClick={() => { onClose(); onOpen(book); }}
                      className="group flex w-full items-center gap-4 px-6 py-3 text-left transition-colors hover:bg-accent-500/10"
                    >
                      <div className="relative">
                        <div className="rounded-xl bg-accent-500/10 p-2 text-accent-500"><BookOpen size={20} /></div>
                        {isDownloaded && (
                          <div className="absolute -right-1.5 -top-1.5 rounded-full border-2 border-white bg-green-500 p-0.5 text-white shadow-sm dark:border-slate-900">
                            <CheckCircle2 size={10} strokeWidth={4} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-4">
                          <span className="truncate text-base font-bold transition-colors group-hover:text-accent-500">{getDisplayBookTitle(book.name)}</span>
                          {(lastDate || percent !== undefined) && (
                            <div className="flex shrink-0 items-center gap-2">
                              {lastDate && <span className="text-[10px] font-bold opacity-40">{lastDate}</span>}
                              {percent !== undefined && percent > 0 && (
                                <span className="rounded-md bg-accent-500/10 px-2 py-0.5 text-xs font-black text-accent-500">{percent.toFixed(1)}%</span>
                              )}
                            </div>
                          )}
                        </div>
                        {(prepared?.catalog?.genreLabel || tagPreview.length > 0) && (
                          <div className="mt-1 flex min-w-0 gap-1 overflow-hidden text-[9px] font-bold opacity-55">
                            {prepared?.catalog?.genreLabel && <span>{prepared.catalog.genreLabel}</span>}
                            {tagPreview.map((tag) => <span key={tag.id}>#{tag.label}</span>)}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="shrink-0 text-accent-500 opacity-0 transition-opacity group-hover:opacity-40" size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="py-12 text-center text-sm font-bold opacity-50">검색 결과가 없습니다.</div>
            )}

            {!tagMode && filteredBooks.length > 0 && (
              <div className={`flex justify-center border-t p-4 ${theme.border} ${theme.secondary}`}>
                <button type="button" onClick={handleSubmit} className="flex items-center gap-2 rounded-full bg-black/5 px-4 py-2 text-[10px] font-black uppercase tracking-widest opacity-60 hover:opacity-100">
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
