'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { Edit3, Trash2, X } from 'lucide-react';
import type {
  Annotation,
  AnnotationPaletteItem,
  HighlightColorId,
  ThemeClasses,
} from '../../types';
import { HIGHLIGHT_COLORS } from '../../lib/annotationPolicy';
import { getAnnotationPaletteItem } from '../../lib/annotationPalette';
import type { SelectionViewportAnchor } from '../../lib/readerTextSelection';

type HighlightActionMenuProps = SelectionViewportAnchor & {
  annotation: Annotation;
  theme: ThemeClasses;
  palette: AnnotationPaletteItem[];
  onChangeColor: (colorId: HighlightColorId) => void;
  onEditNote: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export const HighlightActionMenu: React.FC<HighlightActionMenuProps> = ({
  annotation,
  theme,
  palette,
  x,
  top,
  bottom,
  onChangeColor,
  onEditNote,
  onDelete,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const position = () => {
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const left = Math.min(
        viewportLeft + viewportWidth - menu.offsetWidth - 12,
        Math.max(viewportLeft + 12, x - menu.offsetWidth / 2),
      );
      const below = bottom + 10;
      const above = top - menu.offsetHeight - 10;
      const nextTop = below + menu.offsetHeight <= viewportTop + viewportHeight - 12
        ? below
        : Math.max(viewportTop + 12, above);
      menu.style.left = `${left}px`;
      menu.style.top = `${nextTop}px`;
    };
    position();
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [bottom, top, x]);

  return (
    <div
      ref={menuRef}
      data-reader-highlight-menu="true"
      role="toolbar"
      aria-label="하이라이트 작업"
      className={`app-radius-exempt fixed z-[81] flex max-w-[calc(100vw-24px)] flex-col items-stretch gap-1 rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} p-1.5 shadow-2xl`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-center gap-0.5" aria-label="하이라이트 색상 변경">
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color.id}
            type="button"
            aria-label={`${getAnnotationPaletteItem(palette, color.id).label} 하이라이트`}
            title={getAnnotationPaletteItem(palette, color.id).meaning || color.label}
            aria-pressed={annotation.colorId === color.id}
            onClick={() => onChangeColor(color.id)}
            className="flex size-11 items-center justify-center rounded-xl hover:bg-black/5 active:scale-95 dark:hover:bg-white/10"
          >
            <span
              className={`size-6 rounded-full border-2 ${annotation.colorId === color.id ? 'border-current' : 'border-transparent'}`}
              style={{ backgroundColor: color.color }}
            />
          </button>
        ))}
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          aria-label="하이라이트 메모 편집"
          onClick={onEditNote}
          className={`flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold hover:bg-black/5 active:scale-95 dark:hover:bg-white/10 ${annotation.note ? 'text-accent-500' : ''}`}
        >
          <Edit3 size={17} />
          메모
        </button>
        <button
          type="button"
          aria-label="하이라이트 삭제"
          onClick={onDelete}
          className="flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-bold text-red-500 hover:bg-red-500/10 active:scale-95"
        >
          <Trash2 size={17} />
          삭제
        </button>
        <button
          type="button"
          aria-label="하이라이트 메뉴 닫기"
          onClick={onClose}
          className="flex size-11 items-center justify-center rounded-xl opacity-60 hover:bg-black/5 hover:opacity-100 active:scale-95 dark:hover:bg-white/10"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
};
