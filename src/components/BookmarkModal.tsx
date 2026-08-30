'use client';

import React, { useState } from 'react';
import {
  History,
  Trash2,
} from 'lucide-react';
import type {
  Annotation,
  AnnotationPaletteItem,
  Bookmark,
  HighlightColorId,
  ThemeClasses,
} from '../types';
import { AnnotationPanel } from './AnnotationModal';
import { ReaderModalFrame } from './reader/ReaderModalFrame';
import { MenuSheetHeader } from './MenuSheetHeader';

interface BookmarkModalProps {
  bookmarks: Bookmark[];
  annotations: Annotation[];
  annotationPalette: AnnotationPaletteItem[];
  annotationsEnabled: boolean;
  theme: ThemeClasses;
  onClose: () => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onJump: (cfi: string, progressPercent?: number) => void;
  onJumpToAnnotation: (annotation: Annotation) => void;
  onEditAnnotationNote: (annotation: Annotation) => void;
  onChangeAnnotationColors: (
    annotationIds: string[],
    colorId: HighlightColorId,
  ) => Promise<boolean>;
  onDeleteAnnotations: (annotationIds: string[]) => Promise<boolean>;
  annotationMutationBusy: boolean;
  annotationFeedback: string;
  canUndoAnnotation: boolean;
  onUndoAnnotation: () => void;
}

type RecordsTab = 'bookmarks' | 'annotations';

const LOCAL_MANUAL_BOOKMARK_ADD_LIMIT = 5;

export const BookmarkModal: React.FC<BookmarkModalProps> = ({
  bookmarks,
  annotations,
  annotationPalette,
  annotationsEnabled,
  theme,
  onClose,
  onAdd,
  onDelete,
  onJump,
  onJumpToAnnotation,
  onEditAnnotationNote,
  onChangeAnnotationColors,
  onDeleteAnnotations,
  annotationMutationBusy,
  annotationFeedback,
  canUndoAnnotation,
  onUndoAnnotation,
}) => {
  const [activeTab, setActiveTab] = useState<RecordsTab>('bookmarks');
  const manualBookmarks = bookmarks
    .filter((bookmark) => bookmark.type === 'manual')
    .sort((a, b) => b.createdAt - a.createdAt);
  const autoBookmarks = bookmarks
    .filter((bookmark) => bookmark.type === 'auto')
    .sort((a, b) => b.createdAt - a.createdAt);
  const localAddLimitReached = manualBookmarks.length >= LOCAL_MANUAL_BOOKMARK_ADD_LIMIT;

  return (
    <ReaderModalFrame
      ariaLabel="책갈피와 주석"
      menuSheet
      theme={theme}
      onClose={onClose}
      maxWidth="max-w-[21.25rem]"
      placement="center"
      className="flex h-[34rem] max-h-[85vh] flex-col"
    >
      <MenuSheetHeader kind="bookmarks" title="책갈피·주석" onClose={onClose} borderClass={theme.border} secondaryClass={theme.secondary} />

      <div
        role="tablist"
        aria-label="책갈피와 주석"
        className={`grid shrink-0 ${annotationsEnabled ? 'grid-cols-2' : 'grid-cols-1'} border-b ${theme.border} px-2.5`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'bookmarks'}
          data-reader-records-tab="bookmarks"
          onClick={() => setActiveTab('bookmarks')}
          className={`relative flex min-h-11 items-center justify-center gap-1.5 px-3 text-sm font-black transition-colors ${activeTab === 'bookmarks' ? 'text-accent-500' : 'opacity-55 hover:opacity-80'}`}
        >
          책갈피
          {bookmarks.length > 0 && <span className="text-[10px] tabular-nums">{bookmarks.length}</span>}
          {activeTab === 'bookmarks' && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent-500" />}
        </button>
        {annotationsEnabled && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'annotations'}
            data-reader-records-tab="annotations"
            onClick={() => setActiveTab('annotations')}
            className={`relative flex min-h-11 items-center justify-center gap-1.5 px-3 text-sm font-black transition-colors ${activeTab === 'annotations' ? 'text-accent-500' : 'opacity-55 hover:opacity-80'}`}
          >
            주석
            {annotations.length > 0 && <span className="text-[10px] tabular-nums">{annotations.length}</span>}
            {activeTab === 'annotations' && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent-500" />}
          </button>
        )}
      </div>

      {activeTab === 'annotations' && annotationsEnabled ? (
        <AnnotationPanel
          annotations={annotations}
          palette={annotationPalette}
          theme={theme}
          onEditNote={onEditAnnotationNote}
          onChangeColors={onChangeAnnotationColors}
          onDelete={onDeleteAnnotations}
          mutationBusy={annotationMutationBusy}
          feedback={annotationFeedback}
          canUndo={canUndoAnnotation}
          onUndo={onUndoAnnotation}
          onJump={onJumpToAnnotation}
        />
      ) : (
        <div data-reader-bookmark-panel="true" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <section className="space-y-2">
            <div className="flex items-end justify-between">
              <span className="text-xs font-bold uppercase tracking-wider opacity-50">나만의 책갈피 ({manualBookmarks.length}) · 이 기기 추가 한도 {LOCAL_MANUAL_BOOKMARK_ADD_LIMIT}</span>
            </div>

            <button
              type="button"
              onClick={onAdd}
              disabled={localAddLimitReached}
              className={`flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-2 text-sm font-bold transition-all ${localAddLimitReached
                ? 'cursor-not-allowed border-gray-500/20 text-gray-500/40'
                : 'border-accent-500/30 text-accent-500 hover:bg-accent-500/5 active:scale-95'
              }`}
            >
              {localAddLimitReached ? '이 기기에서 더 추가할 수 없습니다' : '+ 현재 위치 추가하기'}
            </button>

            <div className="mt-2 space-y-1.5">
              {manualBookmarks.map((bookmark) => (
                <div key={bookmark.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onJump(bookmark.cfi, bookmark.progressPercent)}
                    className="app-menu-sheet-section flex w-full gap-2.5 overflow-hidden rounded-xl border border-white/5 p-2.5 pr-12 text-left transition-transform hover:brightness-110 active:scale-95"
                  >
                    <div className={`w-1.5 self-stretch rounded-full ${bookmark.color}`} />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 font-serif text-xs leading-snug opacity-90">&ldquo;{bookmark.name}&rdquo;</p>
                      <p className="mt-1 flex items-center gap-1.5 font-sans text-[9px]">
                        <span className="opacity-40">{new Date(bookmark.createdAt).toLocaleString()}</span>
                        <span className="size-1 rounded-full bg-current opacity-20" />
                        <span className="rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-bold text-accent-500">
                          {bookmark.progressPercent !== undefined ? `${bookmark.progressPercent.toFixed(1)}%` : 'CFI'}
                        </span>
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(bookmark.id);
                    }}
                    aria-label="책갈피 삭제"
                    className="absolute right-1.5 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/20 text-red-400 opacity-60 hover:opacity-100"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {manualBookmarks.length === 0 && (
                <p className="py-2 text-center text-[11px] opacity-30">저장된 책갈피가 없습니다.</p>
              )}
            </div>
          </section>

          <hr className={`border-dashed ${theme.border} opacity-50`} />

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <History size={14} className="opacity-50" />
              <span className="text-xs font-bold uppercase tracking-wider opacity-50">자동 저장 (최근 이동 기록)</span>
            </div>

            {autoBookmarks.length > 0 ? autoBookmarks.map((bookmark) => (
              <button
                type="button"
                key={bookmark.id}
                onClick={() => onJump(bookmark.cfi, bookmark.progressPercent)}
                className="app-menu-sheet-section flex w-full gap-2.5 rounded-xl border border-white/5 p-2.5 text-left transition-transform hover:brightness-110 active:scale-95"
              >
                <div className="w-1.5 self-stretch rounded-full bg-slate-500" />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 font-serif text-xs leading-snug opacity-90">&ldquo;{bookmark.name}&rdquo;</p>
                  <p className="mt-1 flex items-center gap-1.5 font-sans text-[9px]">
                    <span className="opacity-40">{new Date(bookmark.createdAt).toLocaleString()}</span>
                    <span className="size-1 rounded-full bg-current opacity-20" />
                    <span className="rounded bg-accent-500/10 px-1.5 py-0.5 text-[10px] font-bold text-accent-500">
                      {bookmark.progressPercent !== undefined ? `${bookmark.progressPercent.toFixed(1)}%` : 'CFI'}
                    </span>
                  </p>
                </div>
              </button>
            )) : (
                <p className={`app-menu-sheet-section rounded-xl border ${theme.border} py-2.5 text-center text-[11px] opacity-30`}>대량 이동 시 자동으로 생성됩니다.</p>
            )}
          </section>
        </div>
      )}
    </ReaderModalFrame>
  );
};
