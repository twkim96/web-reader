'use client';

import { useId, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

export function LoginProgressDialog({ finishing, onCancel, style }: {
  finishing: boolean;
  onCancel: () => void;
  style: CSSProperties;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useBodyScrollLock();

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!finishing) onCancel(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation(); }}
      className="fixed inset-0 m-auto w-[calc(100%_-_2rem)] max-w-xs rounded-2xl border border-current/15 px-6 py-5 text-center shadow-xl backdrop:bg-black/45"
      style={style}
    >
      <p id={titleId} role="status" className="flex items-center justify-center gap-2.5 text-sm font-semibold">
        <LoaderCircle size={18} aria-hidden="true" className="text-accent-500 motion-safe:animate-spin" />
        {finishing ? '서재 불러오는 중…' : 'Google 로그인 중…'}
      </p>
      {!finishing && (
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 min-h-11 w-full rounded-xl border border-current/15 text-sm font-medium hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-accent-500"
        >
          취소
        </button>
      )}
    </dialog>
  );
}
