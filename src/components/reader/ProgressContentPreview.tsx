'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { FoliateViewElement } from '../../hooks/foliate/types';

type Props = {
  viewRef: React.MutableRefObject<FoliateViewElement | null>;
  percent: number;
  visible: boolean;
  chapter?: string;
  theme: { bg: string; text?: string; border: string };
};

type Preview = { signal: AbortSignal; text?: string; image?: string; percent: number };

export function ProgressContentPreview({ viewRef, percent, visible, chapter, theme }: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const currentUrl = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const view = viewRef.current;
    const release = () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
      currentUrl.current = null;
    };
    if (!visible || !view) return release;
    const timer = setTimeout(() => {
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (signal.aborted || viewRef.current !== view) return;
        try {
          const resolved = view.resolveNavigation({ fraction: Math.max(0, Math.min(1, percent / 100)) });
          const index = resolved?.index;
          if (index === undefined) return;
          const book = view.book;
          let next: Preview;
          if (book?.getPagePreview) {
            const blob = await book.getPagePreview(index, signal);
            if (signal.aborted || viewRef.current !== view) return;
            if (!blob) { setPreview(null); return; }
            const image = URL.createObjectURL(blob);
            release();
            currentUrl.current = image;
            next = { image, percent, signal };
          } else {
            const doc = await book?.sections?.[index]?.createDocument?.();
            if (signal.aborted || viewRef.current !== view) return;
            if (!doc) { setPreview(null); return; }
            doc.querySelectorAll('script, style, template, noscript').forEach(node => node.remove());
            const text = (doc.body?.textContent ?? doc.documentElement.textContent ?? '').replace(/\s+/g, ' ').trim();
            const anchor = typeof resolved?.anchor === 'number' ? resolved.anchor : 0;
            const offset = Math.min(Math.max(0, text.length - 900), Math.floor(text.length * anchor));
            release();
            next = { text: text.slice(offset, offset + 2200), percent, signal };
          }
          setPreview(next);
        } catch {
          if (!signal.aborted) { release(); setPreview(null); }
        }
      });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
      release();
    };
  }, [viewRef, percent, visible]);

  if (!visible) return null;
  const ready = preview?.percent === percent && !preview.signal.aborted;
  return (
    <aside
      data-progress-content-preview="true"
      aria-hidden="true"
      className={`pointer-events-none fixed left-1/2 top-1/2 z-[90] flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border p-5 shadow-2xl ${theme.bg} ${theme.text || ''} ${theme.border}`}
      style={{
        width: 'min(90vw, max(320px, 50vw))',
        height: '50dvh',
        backgroundColor: 'color-mix(in srgb, var(--viewer-theme-bg) 85%, transparent)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
      }}
    >
      <div className="mb-3 flex shrink-0 gap-3 text-xs opacity-70">
        <span className="min-w-0 flex-1 truncate">{chapter}</span>
        <span>{percent.toFixed(1)}%</span>
      </div>
      {ready && preview.image ? (
        // Blob previews have no remote image optimization path.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview.image} alt="" className="min-h-0 flex-1 object-contain" />
      ) : ready && preview.text ? (
        <p className="overflow-hidden whitespace-pre-wrap text-base leading-8">{preview.text}</p>
      ) : <p className="m-auto text-sm opacity-60">미리보기 불러오는 중…</p>}
    </aside>
  );
}
