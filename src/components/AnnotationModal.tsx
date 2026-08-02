'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckSquare,
  ChevronDown,
  Edit3,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Annotation,
  AnnotationPaletteItem,
  HighlightColorId,
  ThemeClasses,
} from '../types';
import {
  ANNOTATION_COLOR_LIMIT,
  getHighlightColor,
  HIGHLIGHT_COLORS,
} from '../lib/annotationPolicy';
import { groupAnnotationsByColor, queryAnnotations, type AnnotationSort } from '../lib/annotationQuery';
import { getAnnotationPaletteItem } from '../lib/annotationPalette';

export interface AnnotationPanelProps {
  annotations: Annotation[];
  palette: AnnotationPaletteItem[];
  theme: ThemeClasses;
  onJump: (annotation: Annotation) => void;
  onEditNote: (annotation: Annotation) => void;
  onChangeColors: (annotationIds: string[], colorId: HighlightColorId) => Promise<boolean>;
  onDelete: (annotationIds: string[]) => Promise<boolean>;
  mutationBusy: boolean;
  feedback: string;
  canUndo: boolean;
  onUndo: () => void;
}

const sortLabels: Array<{ value: AnnotationSort; label: string }> = [
  { value: 'reading', label: '독서 순서' },
  { value: 'created-desc', label: '최근 생성순' },
  { value: 'updated-desc', label: '최근 수정순' },
];

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const formatDate = (timestamp: number) => dateFormatter.format(timestamp);

export const AnnotationPanel: React.FC<AnnotationPanelProps> = ({
  annotations,
  palette,
  theme,
  onJump,
  onEditNote,
  onChangeColors,
  onDelete,
  mutationBusy,
  feedback,
  canUndo,
  onUndo,
}) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<AnnotationSort>('reading');
  const [noteOnly, setNoteOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<HighlightColorId>>(() => (
    new Set(HIGHLIGHT_COLORS.map(({ id }) => id))
  ));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const existing = new Set(annotations.map(({ id }) => id));
    setSelected((current) => new Set([...current].filter((id) => existing.has(id))));
  }, [annotations]);

  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [noteOnly, query]);

  const visible = useMemo(() => queryAnnotations(annotations, palette, {
    query,
    noteOnly,
    sort,
  }), [annotations, noteOnly, palette, query, sort]);
  const groups = useMemo(() => groupAnnotationsByColor(visible), [visible]);
  const totalCounts = useMemo(() => new Map(groupAnnotationsByColor(annotations).map((group) => (
    [group.colorId, group.annotations.length]
  ))), [annotations]);

  const toggleSelected = (annotationId: string) => {
    setConfirmDelete(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(annotationId)) next.delete(annotationId);
      else next.add(annotationId);
      return next;
    });
  };

  const runBatchColor = async (colorId: HighlightColorId) => {
    if (busy || mutationBusy || selected.size === 0) return;
    setBusy(true);
    try {
      if (await onChangeColors([...selected], colorId)) setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (busy || mutationBusy || selected.size === 0) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    try {
      if (await onDelete([...selected])) {
        setSelected(new Set());
        setConfirmDelete(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
      <div data-reader-annotation-modal="true" className="flex min-h-0 flex-1 flex-col font-sans">
        <div className={`shrink-0 space-y-1.5 border-b ${theme.border} p-2.5`}>
          <label className={`flex min-h-10 items-center gap-2 rounded-xl border ${theme.border} bg-black/5 px-2.5 dark:bg-white/5`}>
            <Search size={15} className="shrink-0 opacity-45" />
            <input
              data-reader-annotation-search="true"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="원문·메모·장·팔레트 검색"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기" className="flex size-8 items-center justify-center rounded-full opacity-50 hover:bg-black/5 dark:hover:bg-white/10">
                <X size={14} />
              </button>
            )}
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              aria-label="하이라이트 정렬"
              value={sort}
              onChange={(event) => setSort(event.target.value as AnnotationSort)}
              className={`min-h-9 rounded-lg border ${theme.border} bg-transparent px-2 text-[11px] font-bold outline-none`}
            >
              {sortLabels.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <label className={`flex min-h-9 items-center gap-1.5 rounded-lg border ${theme.border} px-2 text-[11px] font-bold`}>
              <input type="checkbox" checked={noteOnly} onChange={(event) => setNoteOnly(event.target.checked)} className="accent-accent-600" />
              메모 있음
            </label>
            <span className="ml-auto text-[10px] font-bold opacity-45">{visible.length}개</span>
          </div>
        </div>

        {selected.size > 0 && (
          <div className={`shrink-0 border-b ${theme.border} bg-accent-500/10 px-2.5 py-1.5`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 flex min-h-9 items-center gap-1.5 text-[11px] font-black">
                <CheckSquare size={16} /> {selected.size}개 선택
              </span>
              {palette.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  disabled={busy || mutationBusy}
                  onClick={() => void runBatchColor(item.id)}
                  aria-label={`선택 항목을 ${item.label}으로 변경`}
                  title={item.meaning || item.label}
                  className="flex size-9 items-center justify-center rounded-lg hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
                >
                  <span className="size-5 rounded-full border border-black/15 dark:border-white/20" style={{ backgroundColor: getHighlightColor(item.id).color }} />
                </button>
              ))}
              <button
                type="button"
                disabled={busy || mutationBusy}
                onClick={() => void runDelete()}
                className={`ml-auto flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[11px] font-black ${confirmDelete ? 'bg-red-500 text-white' : 'text-red-500 hover:bg-red-500/10'}`}
              >
                <Trash2 size={15} />
                {confirmDelete ? '다시 눌러 삭제' : '삭제'}
              </button>
            </div>
          </div>
        )}

        {feedback && (
          <div
            data-reader-annotation-modal-feedback="true"
            role="status"
            aria-live="polite"
            className={`flex shrink-0 items-center justify-between gap-2 border-b ${theme.border} px-2.5 py-1.5 text-[11px] font-bold`}
          >
            <span>{feedback}</span>
            {canUndo && (
              <button
                type="button"
                onClick={onUndo}
                className="min-h-9 shrink-0 rounded-lg px-2 text-accent-500 hover:bg-black/5 active:scale-95 dark:hover:bg-white/10"
              >
                실행 취소
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <div className="space-y-1.5">
            {groups.map(({ colorId, annotations: items }) => {
              const paletteItem = getAnnotationPaletteItem(palette, colorId);
              const color = getHighlightColor(colorId);
              const isCollapsed = collapsed.has(colorId);
              const total = totalCounts.get(colorId) ?? 0;
              return (
                <section key={colorId} className={`overflow-hidden rounded-xl border ${theme.border}`}>
                  <button
                    type="button"
                    data-reader-annotation-group={colorId}
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(colorId)) next.delete(colorId);
                      else next.add(colorId);
                      return next;
                    })}
                    className="flex min-h-10 w-full items-center gap-2 px-2.5 py-0.5 text-left hover:bg-black/5 dark:hover:bg-white/5"
                  >
                    <span className="size-3.5 shrink-0 rounded-full" style={{ backgroundColor: color.color }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-black">{paletteItem.label}</span>
                      {paletteItem.meaning && <span className="block truncate text-[9px] font-bold opacity-45">{paletteItem.meaning}</span>}
                    </span>
                    <span className="shrink-0 text-[10px] font-black tabular-nums opacity-55">
                      {query || noteOnly ? `${items.length}/` : ''}{total}/{ANNOTATION_COLOR_LIMIT}
                    </span>
                    <ChevronDown size={15} className={`shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                  </button>

                  {!isCollapsed && (
                    <div className={`border-t ${theme.border}`}>
                      {items.length === 0 ? (
                        <p className="px-3 py-2 text-center text-[10px] font-bold opacity-30">해당 항목이 없습니다.</p>
                      ) : items.map((annotation) => (
                        <article key={annotation.id} data-reader-annotation-item={annotation.id} className={`flex gap-1 border-b ${theme.border} px-1.5 py-1 last:border-b-0`}>
                          <label className="flex size-10 shrink-0 items-center justify-center" title="항목 선택">
                            <input
                              type="checkbox"
                              disabled={busy || mutationBusy}
                              checked={selected.has(annotation.id)}
                              onChange={() => toggleSelected(annotation.id)}
                              className="size-4 accent-accent-600"
                              aria-label={`${annotation.quote.slice(0, 30)} 선택`}
                            />
                          </label>
                          <button
                            type="button"
                            disabled={busy || mutationBusy || annotation.anchorState === 'unresolved'}
                            onClick={() => onJump(annotation)}
                            className="min-w-0 flex-1 rounded-lg px-0.5 py-1 text-left active:scale-[0.99] disabled:cursor-not-allowed"
                          >
                            <p className="line-clamp-2 font-serif text-xs leading-snug">“{annotation.quote}”</p>
                            {annotation.note && <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] leading-snug opacity-65">{annotation.note}</p>}
                            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[9px] font-bold opacity-40">
                              {annotation.chapter && <span className="max-w-32 truncate">{annotation.chapter}</span>}
                              {annotation.progressPercent !== null && <span>{annotation.progressPercent.toFixed(1)}%</span>}
                              <span>{formatDate(annotation.updatedAtClient)}</span>
                              {annotation.anchorState === 'unresolved' && <span className="text-red-500 opacity-100">위치 확인 필요</span>}
                            </div>
                          </button>
                          <button
                            type="button"
                            disabled={busy || mutationBusy}
                            onClick={() => onEditNote(annotation)}
                            aria-label="메모 편집"
                            className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${annotation.note ? 'text-accent-500' : 'opacity-45'} hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/10`}
                          >
                            <Edit3 size={17} />
                          </button>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </div>
      </div>
  );
};
