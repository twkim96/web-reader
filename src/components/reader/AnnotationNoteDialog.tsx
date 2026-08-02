'use client';

import React, { useEffect, useState } from 'react';
import { Save, X } from 'lucide-react';
import type { Annotation, AnnotationPaletteItem, ThemeClasses } from '../../types';
import { ANNOTATION_NOTE_MAX_LENGTH, getHighlightColor } from '../../lib/annotationPolicy';
import { ReaderModalFrame } from './ReaderModalFrame';

interface AnnotationNoteDialogProps {
  annotation: Annotation;
  paletteItem: AnnotationPaletteItem;
  theme: ThemeClasses;
  onClose: () => void;
  onSave: (note: string) => Promise<boolean>;
}

export const AnnotationNoteDialog: React.FC<AnnotationNoteDialogProps> = ({
  annotation,
  paletteItem,
  theme,
  onClose,
  onSave,
}) => {
  const [draft, setDraft] = useState(annotation.note);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(annotation.note), [annotation.id, annotation.note]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ReaderModalFrame
      theme={theme}
      onClose={onClose}
      placement="center"
      maxWidth="max-w-lg"
      zIndex="z-[140]"
      className="max-h-[min(88vh,44rem)] font-sans"
    >
      <form data-reader-annotation-note-dialog="true" onSubmit={submit} className="flex max-h-[min(88vh,44rem)] flex-col">
        <div className={`flex items-center justify-between gap-3 border-b ${theme.border} px-5 py-4`}>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-black">
              <span
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: getHighlightColor(annotation.colorId).color }}
              />
              <span className="truncate">{paletteItem.label}</span>
              {paletteItem.meaning && <span className="truncate opacity-45">· {paletteItem.meaning}</span>}
            </div>
            <p className="mt-1 text-[11px] font-bold opacity-45">하이라이트 메모</p>
          </div>
          <button type="button" onClick={onClose} aria-label="메모 닫기" className="flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10">
            <X size={19} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <blockquote className="mb-4 border-l-4 pl-3 font-serif text-sm leading-relaxed opacity-70" style={{ borderColor: getHighlightColor(annotation.colorId).color }}>
            {annotation.quote}
          </blockquote>
          <textarea
            autoFocus
            value={draft}
            maxLength={ANNOTATION_NOTE_MAX_LENGTH}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="이 하이라이트에 메모를 남겨보세요."
            className={`min-h-48 w-full resize-y rounded-2xl border ${theme.border} bg-black/5 px-4 py-3 text-base leading-relaxed outline-none focus:border-accent-500 dark:bg-white/5`}
          />
          <div className="mt-1 text-right text-[10px] font-bold tabular-nums opacity-40">
            {draft.length}/{ANNOTATION_NOTE_MAX_LENGTH}
          </div>
        </div>

        <div className={`flex items-center justify-end gap-2 border-t ${theme.border} px-5 py-4`}>
          <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-4 text-xs font-bold opacity-60 hover:bg-black/5 dark:hover:bg-white/10">
            취소
          </button>
          <button
            type="submit"
            disabled={saving || draft === annotation.note}
            className="flex min-h-11 items-center gap-2 rounded-xl bg-accent-600 px-4 text-xs font-black text-white disabled:opacity-35"
          >
            <Save size={16} />
            {saving ? '저장 중' : '저장'}
          </button>
        </div>
      </form>
    </ReaderModalFrame>
  );
};
