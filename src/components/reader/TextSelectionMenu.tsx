'use client';

import React, { useLayoutEffect, useRef } from 'react';
import { BookOpen, Copy, Languages, Share2, Volume2 } from 'lucide-react';
import type { AnnotationPaletteItem, HighlightColorId, ThemeClasses } from '../../types';
import type { ReaderTextSelection } from '../../hooks/reader/useReaderTextSelection';
import { HIGHLIGHT_COLORS } from '../../lib/annotationPolicy';
import { getAnnotationPaletteItem } from '../../lib/annotationPalette';

interface TextSelectionMenuProps {
  selection: ReaderTextSelection;
  feedback: string;
  canShare: boolean;
  theme: ThemeClasses;
  palette: AnnotationPaletteItem[];
  onCopy: () => void;
  onShare: () => void;
  onTranslate: () => void;
  onDictionary: () => void;
  onSpeak: () => void;
  onHighlight: (colorId: HighlightColorId) => void;
}

const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 10;

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({
  selection,
  feedback,
  canShare,
  theme,
  palette,
  onCopy,
  onShare,
  onTranslate,
  onDictionary,
  onSpeak,
  onHighlight,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const positionMenu = () => {
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const minLeft = viewportLeft + VIEWPORT_MARGIN;
      const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - width - VIEWPORT_MARGIN);
      const left = Math.min(maxLeft, Math.max(minLeft, selection.x - width / 2));
      const maxTop = Math.max(
        viewportTop + VIEWPORT_MARGIN,
        viewportTop + viewportHeight - height - VIEWPORT_MARGIN,
      );
      const below = selection.bottom + ANCHOR_GAP;
      const above = selection.top - height - ANCHOR_GAP;
      const top = below + height <= viewportTop + viewportHeight - VIEWPORT_MARGIN
        ? below
        : Math.min(maxTop, Math.max(viewportTop + VIEWPORT_MARGIN, above));

      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };

    positionMenu();
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', positionMenu);
    viewport?.addEventListener('scroll', positionMenu);
    window.addEventListener('resize', positionMenu);
    return () => {
      viewport?.removeEventListener('resize', positionMenu);
      viewport?.removeEventListener('scroll', positionMenu);
      window.removeEventListener('resize', positionMenu);
    };
  }, [feedback, selection]);

  const actionClass = "flex h-11 w-10 items-center justify-center rounded-xl hover:bg-black/5 active:scale-95 dark:hover:bg-white/10";

  const stopPropagation = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  return (
    <div
      ref={menuRef}
      data-reader-selection-menu="true"
      role="toolbar"
      aria-label="선택한 텍스트 작업"
      className={`app-radius-exempt fixed z-[80] flex max-w-[calc(100vw-24px)] flex-col items-stretch gap-1 rounded-2xl border ${theme.border} ${theme.bg} ${theme.text} p-1.5 shadow-2xl`}
      onPointerDown={stopPropagation}
      onTouchStart={stopPropagation}
      onClick={stopPropagation}
    >
      <div className="grid grid-cols-5" aria-label="하이라이트 색상">
        {HIGHLIGHT_COLORS.map((color) => (
          <button
            key={color.id}
            type="button"
            aria-label={`${getAnnotationPaletteItem(palette, color.id).label} 하이라이트 추가`}
            title={getAnnotationPaletteItem(palette, color.id).meaning || color.label}
            onClick={() => onHighlight(color.id)}
            className={actionClass}
          >
            <span
              className="size-7 rounded-md border border-black/15 dark:border-white/20"
              style={{ backgroundColor: color.color }}
            />
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5">
        <button
          type="button"
          aria-label="복사"
          title="복사"
          onClick={onCopy}
          className={actionClass}
        >
          <Copy size={17} />
        </button>
        {canShare ? (
          <button
            type="button"
            aria-label="공유"
            title="공유"
            onClick={onShare}
            className={actionClass}
          >
            <Share2 size={17} />
          </button>
        ) : <span aria-hidden="true" />}
        <button
          type="button"
          data-reader-selection-translate="true"
          aria-label="번역"
          title="번역"
          onClick={onTranslate}
          className={actionClass}
        >
          <Languages size={17} />
        </button>
        <button
          type="button"
          data-reader-selection-speak="true"
          aria-label="듣기"
          title="듣기"
          onClick={onSpeak}
          className={actionClass}
        >
          <Volume2 size={17} />
        </button>
        <button
          type="button"
          data-reader-selection-dictionary="true"
          aria-label="사전"
          title="사전"
          onClick={onDictionary}
          className={actionClass}
        >
          <BookOpen size={17} />
        </button>
      </div>
      {feedback && (
        <span className="max-w-full break-words px-2 pb-1 text-center text-[11px] font-bold text-accent-500" role="status" aria-live="polite">
          {feedback}
        </span>
      )}
    </div>
  );
};
