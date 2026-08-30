import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ,
  ChevronDown,
  Clock3,
  Flame,
  LoaderCircle,
  RotateCcw,
} from 'lucide-react';
import type { PublicBookCatalogSnapshot } from '../../lib/publicBookCatalog';
import type { PublicBookCatalogLoadState } from '../../hooks/usePublicBookCatalog';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import {
  EMPTY_SHELF_FILTERS,
  filterAndSortPreparedBooks,
  type PreparedShelfBook,
  type ShelfFilters,
  type ShelfSortMode,
  type ShelfSourceFilter,
  type ShelfTheme,
} from './bookUtils';
import {
  getNextShelfTagCount,
  getShelfPopularTags,
  SHELF_TAG_PAGE_SIZE,
} from './filterTags';
import { MenuSheetHeader } from '../MenuSheetHeader';

type Props = {
  books: PreparedShelfBook[];
  filters: ShelfFilters;
  sortMode: ShelfSortMode;
  catalog: PublicBookCatalogSnapshot | null;
  catalogState: PublicBookCatalogLoadState;
  theme: ShelfTheme;
  onApply: (sortMode: ShelfSortMode, filters: ShelfFilters) => void;
  onRetryCatalog: () => void;
  onClose: () => void;
};

const sourceOptions: Array<{ id: ShelfSourceFilter; label: string }> = [
  { id: 'series', label: '시리즈' },
  { id: 'kakao', label: '카카오' },
  { id: 'novelpia', label: '노벨피아' },
  { id: 'none', label: '없음(기타)' },
];

const sortOptions: Array<{
  id: ShelfSortMode;
  label: string;
  icon: typeof Clock3;
}> = [
  { id: 'recent', label: '최근에 읽은 순', icon: Clock3 },
  { id: 'alpha', label: '가나다순', icon: ArrowDownAZ },
  { id: 'popularity', label: '통합 인기순', icon: Flame },
];

const toggle = <T,>(items: readonly T[], value: T) => (
  items.includes(value) ? items.filter((item) => item !== value) : [...items, value]
);

export const ShelfFilterModal: React.FC<Props> = ({
  books,
  filters,
  sortMode,
  catalog,
  catalogState,
  theme,
  onApply,
  onRetryCatalog,
  onClose,
}) => {
  useBodyScrollLock();
  const dialogRef = useRef<HTMLElement>(null);
  const [draftSort, setDraftSort] = useState(sortMode);
  const [draftFilters, setDraftFilters] = useState<ShelfFilters>(() => ({
    sources: [...filters.sources],
    genreIds: [...filters.genreIds],
    tagIds: [...filters.tagIds],
  }));
  const [visibleTagCount, setVisibleTagCount] = useState(SHELF_TAG_PAGE_SIZE);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  const genres = useMemo(() => (
    catalog ? [...catalog.genres.entries()].sort((left, right) => (
      left[1].localeCompare(right[1], 'ko-KR') || left[0] - right[0]
    )) : []
  ), [catalog]);
  const shelfPopularTags = useMemo(
    () => getShelfPopularTags(books, catalog),
    [books, catalog],
  );
  const shelfTagCountById = useMemo(
    () => new Map(shelfPopularTags.map((tag) => [tag.id, tag.shelfTitleCount])),
    [shelfPopularTags],
  );
  const visibleTags = shelfPopularTags.slice(0, visibleTagCount);
  const visibleTagIds = new Set(visibleTags.map((tag) => tag.id));
  const selectedTags = draftFilters.tagIds.flatMap((tagId) => {
    const tag = catalog?.tags.get(tagId);
    return tag && !visibleTagIds.has(tag.id) ? [{
      ...tag,
      shelfTitleCount: shelfTagCountById.get(tag.id) ?? 0,
    }] : [];
  }).sort((left, right) => (
    right.shelfTitleCount - left.shelfTitleCount
    || left.label.localeCompare(right.label, 'ko-KR')
  ));
  const resultCount = useMemo(() => filterAndSortPreparedBooks(
    books,
    '',
    draftSort,
    [],
    draftFilters,
  ).length, [books, draftFilters, draftSort]);
  const catalogReady = catalogState === 'ready' && Boolean(catalog);
  const chip = (active: boolean) => `app-tag-radius app-tag-material app-filter-tag-material app-menu-sheet-section app-menu-sheet-chip border px-2.5 py-1 text-[11px] font-bold transition-colors sm:px-3 sm:py-1.5 sm:text-xs ${
    active
      ? 'border-accent-500 [--app-tag-color:var(--accent-500)]'
      : `${theme.border} hover:border-accent-500/50`
  }`;

  return (
    <div
      data-menu-sheet-backdrop="true"
      className="app-menu-sheet-backdrop fixed inset-0 z-[180] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-5"
      onClick={onClose}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shelf-filter-title"
        tabIndex={-1}
        data-shelf-filter-modal="true"
        data-menu-sheet="true"
        onClick={(event) => event.stopPropagation()}
        className={`app-panel-radius app-menu-sheet flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden border ${theme.border} ${theme.bg} ${theme.text} shadow-2xl outline-none`}
      >
        <MenuSheetHeader kind="shelf-filter" title="책장 정렬·필터" titleId="shelf-filter-title" subtitle="정렬과 조건을 함께 적용합니다." onClose={onClose} borderClass={theme.border} secondaryClass={theme.secondary} />

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-3 sm:space-y-5 sm:px-4 sm:py-4">
          <section aria-labelledby="shelf-filter-sort-title">
            <h3 id="shelf-filter-sort-title" className="text-xs font-black opacity-55">정렬</h3>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {sortOptions.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  data-shelf-filter-sort={id}
                  aria-pressed={draftSort === id}
                  disabled={id === 'popularity' && !catalogReady}
                  onClick={() => setDraftSort(id)}
                  className={`app-menu-sheet-section app-menu-sheet-choice flex min-h-11 items-center justify-center gap-1 rounded-xl border px-1.5 text-[10px] font-bold transition-colors disabled:opacity-35 sm:min-h-16 sm:flex-col sm:px-2 sm:text-[11px] ${
                    draftSort === id
                      ? 'border-accent-500 bg-accent-500/12 text-accent-500'
                      : theme.border
                  }`}
                >
                  <Icon className="size-4 shrink-0 sm:size-[17px]" />
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="shelf-filter-source-title">
            <h3 id="shelf-filter-source-title" className="text-xs font-black opacity-55">도서 출처</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sourceOptions.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  disabled={!catalogReady}
                  aria-pressed={draftFilters.sources.includes(id)}
                  onClick={() => setDraftFilters((current) => ({
                    ...current,
                    sources: toggle(current.sources, id),
                  }))}
                  className={`${chip(draftFilters.sources.includes(id))} disabled:opacity-35`}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="shelf-filter-genre-title">
            <h3 id="shelf-filter-genre-title" className="text-xs font-black opacity-55">장르</h3>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {genres.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={draftFilters.genreIds.includes(id)}
                  onClick={() => setDraftFilters((current) => ({
                    ...current,
                    genreIds: toggle(current.genreIds, id),
                  }))}
                  className={chip(draftFilters.genreIds.includes(id))}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="shelf-filter-tag-title">
            <div className="flex items-center justify-between gap-3">
              <h3 id="shelf-filter-tag-title" className="text-xs font-black opacity-55">인기 태그</h3>
              <span className="text-[10px] opacity-40">현재 책장 작품이 많은 순</span>
            </div>
            {selectedTags.length > 0 && (
              <div data-shelf-selected-tags="true" className="mt-2 rounded-xl bg-accent-500/8 p-2">
                <p className="mb-1.5 text-[10px] font-black text-accent-500">선택됨</p>
                <div className="flex flex-wrap gap-1.5">
                  {selectedTags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      aria-pressed="true"
                      onClick={() => setDraftFilters((current) => ({
                        ...current,
                        tagIds: toggle(current.tagIds, tag.id),
                      }))}
                      className={chip(true)}
                    >
                      #{tag.label}
                      {tag.shelfTitleCount > 0 && (
                        <> <span className="opacity-55">{tag.shelfTitleCount.toLocaleString('ko-KR')}</span></>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div data-shelf-popular-tags="true" className="mt-2 flex flex-wrap gap-1.5">
              {visibleTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  data-shelf-filter-tag={tag.id}
                  aria-pressed={draftFilters.tagIds.includes(tag.id)}
                  onClick={() => setDraftFilters((current) => ({
                    ...current,
                    tagIds: toggle(current.tagIds, tag.id),
                  }))}
                  className={chip(draftFilters.tagIds.includes(tag.id))}
                >
                  #{tag.label}
                  {tag.shelfTitleCount > 0 && (
                    <> <span className="opacity-55">{tag.shelfTitleCount.toLocaleString('ko-KR')}</span></>
                  )}
                </button>
              ))}
            </div>
            {catalog && visibleTagCount < shelfPopularTags.length && (
              <button
                type="button"
                data-shelf-tags-more="true"
                onClick={() => setVisibleTagCount((current) => getNextShelfTagCount(
                  current,
                  shelfPopularTags.length,
                ))}
                className={`app-menu-sheet-section mt-2 flex min-h-9 w-full items-center justify-center gap-1 rounded-xl border ${theme.border} text-[11px] font-bold opacity-65 hover:opacity-100 sm:min-h-10 sm:text-xs`}
              >
                <ChevronDown size={15} /> 태그 15개 더보기
              </button>
            )}
          </section>

          {catalogState !== 'ready' && (
            <div className={`app-menu-sheet-section rounded-xl border ${theme.border} p-3 text-xs`} role="status">
              {catalogState === 'loading' ? (
                <span className="flex items-center gap-2 opacity-60">
                  <LoaderCircle size={15} className="animate-spin" /> 카탈로그를 불러오는 중…
                </span>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <span className="opacity-60">메타데이터 필터를 불러오지 못했습니다.</span>
                  <button type="button" onClick={onRetryCatalog} className="font-bold text-accent-500">재시도</button>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className={`grid grid-cols-[auto_1fr] gap-2 border-t ${theme.border} px-3 pb-3 pt-3 sm:px-4`}>
          <button
            type="button"
            onClick={() => {
              setDraftSort('recent');
              setDraftFilters({ ...EMPTY_SHELF_FILTERS });
              setVisibleTagCount(SHELF_TAG_PAGE_SIZE);
            }}
            className={`flex min-h-11 items-center justify-center gap-1.5 rounded-xl border ${theme.border} px-4 text-xs font-bold`}
          >
            <RotateCcw size={15} /> 초기화
          </button>
          <button
            type="button"
            data-shelf-filter-apply="true"
            onClick={() => onApply(draftSort, draftFilters)}
            className="min-h-11 rounded-xl bg-accent-600 px-4 text-sm font-black text-white"
          >
            {resultCount.toLocaleString('ko-KR')}권 보기
          </button>
        </footer>
      </section>
    </div>
  );
};
