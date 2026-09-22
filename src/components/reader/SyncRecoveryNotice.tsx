'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';

export function SyncRecoveryNotice({ visible, busy, onMove, onDismiss }: {
  visible: boolean;
  busy: boolean;
  onMove: () => void;
  onDismiss: () => void;
}) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!visible || busy || paused) return;
    const hide = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(hide);
  }, [busy, onDismiss, paused, visible]);
  if (!visible) return null;
  return (
    <div
      role="group"
      aria-label="동기화 지점"
      data-sync-recovery-notice="true"
      className="app-menu-sheet fixed z-[90] flex items-center rounded-full border shadow-lg motion-reduce:animate-none"
      style={{ right: 'max(16px, env(safe-area-inset-right))', bottom: 'calc(24px + env(safe-area-inset-bottom))', animation: busy || paused ? 'none' : 'reader-sync-recovery-dismiss 8s linear forwards' }}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button type="button" disabled={busy} onClick={onMove} className="relative z-10 flex min-h-11 items-center gap-1.5 rounded-full pl-4 pr-2 text-xs font-bold disabled:opacity-50">
        {busy ? '이동 중…' : '동기화 지점으로 이동'}<ArrowUpRight size={15} aria-hidden="true" />
      </button>
      <button type="button" disabled={busy} onClick={onDismiss} aria-label="동기화 안내 닫기" className="relative z-10 flex size-11 items-center justify-center rounded-full opacity-60 hover:opacity-100">
        <X size={15} />
      </button>
    </div>
  );
}
