'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  Download,
  FileJson,
  FileText,
  Search,
  Share2,
  X,
} from 'lucide-react';
import type {
  Annotation,
  AnnotationPaletteItem,
  Book,
  HighlightColorId,
  ThemeClasses,
} from '../types';
import type { OwnerKey } from '../lib/ownerIdentity';
import { getAllLocalAnnotationsV8 } from '../lib/localAnnotations';
import { getLocalAnnotationPaletteV9 } from '../lib/localAnnotationPalette';
import { getStoredAnnotationPalette } from '../lib/annotationPalette';
import {
  buildLibraryAnnotationIndex,
  queryLibraryAnnotationIndex,
  type LibraryAnnotationIndexEntry,
  type LibraryAnnotationSort,
} from '../lib/annotationQuery';
import { getHighlightColor } from '../lib/annotationPolicy';
import {
  createAnnotationJsonExport,
  createAnnotationMarkdownExport,
  type AnnotationExportFile,
} from '../lib/annotationExport';
import {
  canShareAnnotationExport,
  downloadAnnotationExport,
  shareAnnotationExport,
} from '../lib/annotationExportDelivery';
import { subscribeAnnotationSyncChanges } from '../lib/annotationSyncWake';

type ExportMode = 'markdown-library' | 'markdown-book' | 'json-library';

type Props = {
  open: boolean;
  visible: boolean;
  ownerKey: OwnerKey;
  books: Book[];
  theme: ThemeClasses;
  onClose: () => void;
  onJump: (annotation: Annotation, book: Book) => void;
};

const PAGE_SIZE = 100;

const sortLabels: Array<{ value: LibraryAnnotationSort; label: string }> = [
  { value: 'updated-desc', label: '최근 수정순' },
  { value: 'created-desc', label: '최근 생성순' },
  { value: 'book-reading', label: '책·독서 순서' },
];

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: '2-digit',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export const LibraryAnnotationModal: React.FC<Props> = ({
  open,
  visible,
  ownerKey,
  books,
  theme,
  onClose,
  onJump,
}) => {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [palette, setPalette] = useState<AnnotationPaletteItem[]>(() => (
    getStoredAnnotationPalette(ownerKey)
  ));
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [bookId, setBookId] = useState('');
  const [colorId, setColorId] = useState<HighlightColorId | ''>('');
  const [noteOnly, setNoteOnly] = useState(false);
  const [sort, setSort] = useState<LibraryAnnotationSort>('updated-desc');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [exportMode, setExportMode] = useState<ExportMode>('markdown-library');
  const [feedback, setFeedback] = useState('');
  const [sharing, setSharing] = useState(false);

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const fallback = getStoredAnnotationPalette(ownerKey);
      const [nextAnnotations, nextPalette] = await Promise.all([
        getAllLocalAnnotationsV8(ownerKey),
        getLocalAnnotationPaletteV9(ownerKey, fallback),
      ]);
      setAnnotations(nextAnnotations);
      setPalette(nextPalette);
    } catch (error) {
      console.error('[LibraryAnnotations] load failed:', error);
      setFeedback('주석을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [ownerKey]);

  useEffect(() => {
    if (!open) return;
    void reload(true);
    return subscribeAnnotationSyncChanges(ownerKey, () => void reload());
  }, [open, ownerKey, reload]);

  const index = useMemo(
    () => buildLibraryAnnotationIndex(annotations, books, palette),
    [annotations, books, palette],
  );
  const booksById = useMemo(
    () => new Map(books.map((book) => [book.id, book])),
    [books],
  );
  const annotatedBooks = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const { annotation, book } of index) {
      byId.set(annotation.bookId, {
        id: annotation.bookId,
        name: book?.name ?? `알 수 없는 도서 (${annotation.bookId})`,
      });
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'ko'));
  }, [index]);
  const results = useMemo(() => queryLibraryAnnotationIndex(index, {
    query,
    bookId: bookId || undefined,
    colorId: colorId || undefined,
    noteOnly,
    sort,
  }), [bookId, colorId, index, noteOnly, query, sort]);
  const visibleResults = results.slice(0, visibleCount);

  const resetPage = () => setVisibleCount(PAGE_SIZE);
  const setQueryFilter = (value: string) => {
    setQuery(value);
    resetPage();
  };
  const setBookFilter = (value: string) => {
    setBookId(value);
    resetPage();
    if (!value && exportMode === 'markdown-book') setExportMode('markdown-library');
  };

  const exportFile = useMemo((): AnnotationExportFile => {
    if (exportMode === 'markdown-book' && bookId) {
      const selected = index.filter(({ annotation }) => annotation.bookId === bookId);
      const title = annotatedBooks.find(({ id }) => id === bookId)?.name ?? bookId;
      return createAnnotationMarkdownExport(selected, palette, { title });
    }
    if (exportMode === 'json-library') {
      return createAnnotationJsonExport(index, palette);
    }
    return createAnnotationMarkdownExport(index, palette, { title: 'library-annotations' });
  }, [annotatedBooks, bookId, exportMode, index, palette]);

  const runDownload = () => {
    try {
      downloadAnnotationExport(exportFile);
      setFeedback(`${exportFile.filename} 다운로드를 시작했습니다.`);
    } catch (error) {
      console.error('[LibraryAnnotations] download failed:', error);
      setFeedback('파일 다운로드를 시작하지 못했습니다.');
    }
  };

  const runShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (await shareAnnotationExport(exportFile)) {
        setFeedback('시스템 공유를 열었습니다.');
      } else {
        downloadAnnotationExport(exportFile);
        setFeedback('파일 공유를 지원하지 않아 다운로드로 저장했습니다.');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('[LibraryAnnotations] share failed:', error);
      setFeedback('파일을 공유하지 못했습니다.');
    } finally {
      setSharing(false);
    }
  };

  if (!open || !visible) return null;

  return (
    <div className="fixed inset-0 z-[115] flex items-center justify-center bg-black/65 p-2 backdrop-blur-sm md:p-5">
      <section
        data-library-annotation-modal="true"
        aria-label="라이브러리 전체 주석"
        className={`flex h-[min(92dvh,54rem)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border shadow-2xl md:rounded-3xl ${theme.bg} ${theme.text} ${theme.border}`}
      >
        <header className={`flex min-h-14 shrink-0 items-center gap-3 border-b px-3 md:px-5 ${theme.border}`}>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-black md:text-lg">라이브러리 주석</h2>
            <p className="text-[10px] font-bold opacity-45">로컬 {annotations.length}개 · 삭제 기록 제외 · 위치 오류 항목 포함</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="라이브러리 주석 닫기"
            className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X size={20} />
          </button>
        </header>

        <div className={`shrink-0 space-y-2 border-b p-2.5 md:p-3 ${theme.border}`}>
          <label className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 ${theme.border} bg-black/5 dark:bg-white/5`}>
            <Search size={17} className="shrink-0 opacity-45" />
            <input
              data-library-annotation-search="true"
              value={query}
              onChange={(event) => setQueryFilter(event.target.value)}
              placeholder="원문·메모·책·장·팔레트 검색"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {query && (
              <button type="button" onClick={() => setQueryFilter('')} aria-label="검색어 지우기" className="flex size-8 items-center justify-center rounded-full opacity-50">
                <X size={14} />
              </button>
            )}
          </label>
          <div className="grid grid-cols-2 gap-1.5 md:flex md:flex-wrap">
            <select
              aria-label="주석 도서 필터"
              value={bookId}
              onChange={(event) => setBookFilter(event.target.value)}
              className={`min-h-10 min-w-0 rounded-lg border bg-transparent px-2 text-xs font-bold outline-none md:max-w-64 ${theme.border}`}
            >
              <option value="">모든 책</option>
              {annotatedBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}
            </select>
            <select
              aria-label="주석 색상 필터"
              value={colorId}
              onChange={(event) => { setColorId(event.target.value as HighlightColorId | ''); resetPage(); }}
              className={`min-h-10 rounded-lg border bg-transparent px-2 text-xs font-bold outline-none ${theme.border}`}
            >
              <option value="">모든 색상</option>
              {palette.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            <select
              aria-label="라이브러리 주석 정렬"
              value={sort}
              onChange={(event) => { setSort(event.target.value as LibraryAnnotationSort); resetPage(); }}
              className={`min-h-10 rounded-lg border bg-transparent px-2 text-xs font-bold outline-none ${theme.border}`}
            >
              {sortLabels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <label className={`flex min-h-10 items-center gap-2 rounded-lg border px-2 text-xs font-bold ${theme.border}`}>
              <input
                type="checkbox"
                checked={noteOnly}
                onChange={(event) => { setNoteOnly(event.target.checked); resetPage(); }}
                className="accent-accent-600"
              />
              메모 있음
            </label>
          </div>
        </div>

        <div className={`shrink-0 border-b p-2.5 ${theme.border}`}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-1.5">
            <label className={`relative flex min-h-10 items-center rounded-lg border ${theme.border}`}>
              {exportMode === 'json-library' ? <FileJson size={16} className="ml-2.5 opacity-50" /> : <FileText size={16} className="ml-2.5 opacity-50" />}
              <select
                data-library-annotation-export-format="true"
                aria-label="주석 내보내기 형식"
                value={exportMode}
                onChange={(event) => setExportMode(event.target.value as ExportMode)}
                className="min-w-0 flex-1 appearance-none bg-transparent px-2 pr-7 text-xs font-bold outline-none"
              >
                <option value="markdown-library">전체 Markdown</option>
                <option value="markdown-book" disabled={!bookId}>선택한 책 Markdown</option>
                <option value="json-library">전체 JSON v1</option>
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-2 opacity-40" />
            </label>
            <button
              type="button"
              data-library-annotation-download="true"
              onClick={runDownload}
              disabled={loading}
              className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-black disabled:opacity-40 ${theme.border}`}
            >
              <Download size={16} /> <span className="hidden sm:inline">다운로드</span>
            </button>
            <button
              type="button"
              data-library-annotation-share="true"
              onClick={() => void runShare()}
              disabled={loading || sharing}
              title={canShareAnnotationExport(exportFile) ? '시스템 공유' : '미지원 시 다운로드'}
              className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-black disabled:opacity-40 ${theme.border}`}
            >
              <Share2 size={16} /> <span className="hidden sm:inline">공유</span>
            </button>
          </div>
          {feedback && <p role="status" className="mt-1.5 text-[10px] font-bold opacity-60">{feedback}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5 md:p-3">
          {loading ? (
            <p className="py-12 text-center text-sm font-bold opacity-40">주석을 불러오는 중...</p>
          ) : results.length === 0 ? (
            <p className="py-12 text-center text-sm font-bold opacity-40">조건에 맞는 주석이 없습니다.</p>
          ) : (
            <div className="space-y-1.5">
              <p className="px-1 pb-1 text-[10px] font-bold opacity-45">{results.length}개 중 {visibleResults.length}개 표시</p>
              {visibleResults.map((entry: LibraryAnnotationIndexEntry) => {
                const { annotation, book } = entry;
                const color = getHighlightColor(annotation.colorId);
                const availableBook = booksById.get(annotation.bookId);
                const canJump = Boolean(availableBook) && annotation.anchorState === 'active';
                return (
                  <article
                    key={`${annotation.bookId}:${annotation.id}`}
                    data-library-annotation-item={annotation.id}
                    className={`rounded-xl border p-2.5 ${theme.border}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="mt-1 size-3 shrink-0 rounded-full" style={{ backgroundColor: color.color }} />
                      <button
                        type="button"
                        disabled={!canJump}
                        onClick={() => { if (availableBook) onJump(annotation, availableBook); }}
                        className="min-w-0 flex-1 text-left disabled:cursor-not-allowed"
                      >
                        <p className="truncate text-[11px] font-black opacity-55">{book?.name ?? `알 수 없는 도서 · ${annotation.bookId}`}</p>
                        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap font-serif text-sm leading-snug">“{annotation.quote}”</p>
                        {annotation.note && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-snug opacity-65">{annotation.note}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold opacity-40">
                          {annotation.chapter && <span>{annotation.chapter}</span>}
                          {annotation.progressPercent !== null && <span>{annotation.progressPercent.toFixed(1)}%</span>}
                          <span>{dateFormatter.format(annotation.updatedAtClient)}</span>
                          {!book && <span className="text-amber-500 opacity-100">이 기기에 도서 없음</span>}
                          {annotation.anchorState === 'unresolved' && <span className="text-red-500 opacity-100">위치 확인 필요</span>}
                        </div>
                      </button>
                      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${canJump ? 'text-accent-500' : 'opacity-20'}`}>
                        <BookOpen size={17} />
                      </span>
                    </div>
                  </article>
                );
              })}
              {visibleResults.length < results.length && (
                <button
                  type="button"
                  onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
                  className={`min-h-11 w-full rounded-xl border text-xs font-black ${theme.border}`}
                >
                  더 보기 ({results.length - visibleResults.length}개 남음)
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
