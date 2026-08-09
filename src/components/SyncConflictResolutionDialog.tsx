'use client';

import { useEffect, useRef } from 'react';
import type { ThemeClasses } from '../types';
import type { SyncConflictV5 } from '../lib/syncOutboxV5';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

type Props = {
  conflict: SyncConflictV5;
  theme: ThemeClasses;
  onKeepLocal: () => void;
  onUseRemote: () => void;
  onDefer: () => void;
  bookTitle?: string;
  resolving?: boolean;
  error?: string | null;
};

const truncate = (value: string, maxLength = 72) => (
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`
);

const formatPercent = (value: number | null | undefined) => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '위치 정보 없음'
);

const formatServerTime = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if ('toMillis' in value && typeof value.toMillis === 'function') {
      const milliseconds = value.toMillis();
      return Number.isFinite(milliseconds) ? new Date(milliseconds).toLocaleString('ko-KR') : null;
    }
    if ('seconds' in value && Number.isFinite(value.seconds)) {
      const milliseconds = Number(value.seconds) * 1_000
        + ('nanoseconds' in value && Number.isFinite(value.nanoseconds)
          ? Math.floor(Number(value.nanoseconds) / 1_000_000)
          : 0);
      return new Date(milliseconds).toLocaleString('ko-KR');
    }
  } catch {
    return null;
  }
  return null;
};

export const SyncConflictResolutionDialog = ({
  conflict,
  theme,
  onKeepLocal,
  onUseRemote,
  onDefer,
  bookTitle,
  resolving = false,
  error = null,
}: Props) => {
  useBodyScrollLock();
  const dialogRef = useRef<HTMLDivElement>(null);
  const deferRef = useRef(onDefer);
  useEffect(() => {
    deferRef.current = onDefer;
  }, [onDefer]);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusableSelector = 'button:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (resolving) return;
        event.preventDefault();
        deferRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const focusFrame = window.requestAnimationFrame(() => {
      (dialog?.querySelector<HTMLElement>(focusableSelector) ?? dialog)?.focus();
    });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [resolving]);

  const targetLabel = conflict.event?.target.kind === 'bookmark'
    ? '북마크'
    : conflict.event?.target.kind === 'annotation'
      ? '하이라이트·메모'
      : conflict.event?.target.kind === 'palette'
        ? '형광펜 팔레트'
        : '읽기 위치';
  const remoteMissing = conflict.remoteHead === null;
  const policyConflict = conflict.conflictReason !== undefined;
  const capacityConflict = conflict.conflictReason === 'annotation-color-limit'
    || conflict.conflictReason === 'annotation-book-limit'
    || conflict.conflictReason === 'annotation-aggregate-size';
  const generationConflict = conflict.conflictReason === 'annotation-book-generation';
  const requiresRemoteResolution = policyConflict && !generationConflict;
  const existingPolicyTarget = policyConflict && conflict.remoteHead !== null;
  const localProgressPercent = conflict.event?.target.kind === 'progress'
    && conflict.latestLocalPosition
    && 'anchorCfi' in conflict.latestLocalPosition
      ? conflict.latestLocalPosition.progressPercent
      : null;
  const remoteProgressPercent = conflict.remoteHead
    && 'position' in conflict.remoteHead
    && conflict.remoteHead.operation === 'set'
      ? conflict.remoteHead.position?.progressPercent ?? null
      : conflict.remoteHead && 'position' in conflict.remoteHead
        ? 0
        : null;
  const remoteActionLabel = existingPolicyTarget
    ? conflict.conflictReason === 'annotation-color-limit'
      ? '원격 색상 유지'
      : '원격 상태로 되돌리기'
    : conflict.conflictReason === 'annotation-duplicate-range'
    ? '이 기기의 중복 하이라이트 삭제'
    : requiresRemoteResolution || generationConflict
      ? '이 기기의 추가 하이라이트 삭제'
    : remoteMissing && conflict.event?.target.kind === 'annotation'
    ? '원격에서 삭제됨 — 이 기기에서도 삭제'
    : remoteMissing && conflict.event?.target.kind === 'palette'
      ? '원격 설정 없음 — 기본 팔레트로 초기화'
      : '원격 값 사용';
  const remoteChangedAt = conflict.remoteHead?.occurredAtClient;
  const remoteServerTime = formatServerTime(conflict.remoteHead?.updatedAtServer);
  const formatConflictTime = (value: number | undefined) => (
    Number.isFinite(value) ? new Date(value as number).toLocaleString('ko-KR') : null
  );
  const comparison = (() => {
    const kind = conflict.event?.target.kind;
    if (kind === 'progress') {
      return {
        local: localProgressPercent === null ? '읽기 기록 없음' : formatPercent(localProgressPercent),
        remote: remoteProgressPercent === null ? '읽기 기록 없음' : formatPercent(remoteProgressPercent),
      };
    }
    if (kind === 'bookmark') {
      const local = conflict.latestLocalPosition
        && 'bookmarkId' in conflict.latestLocalPosition
        ? conflict.latestLocalPosition
        : null;
      const remote = conflict.remoteHead && 'bookmarkId' in conflict.remoteHead
        ? conflict.remoteHead.bookmark
        : null;
      return {
        local: local
          ? `${truncate(local.name || '이름 없는 책갈피', 42)} · ${formatPercent(local.progressPercent)}`
          : '삭제됨',
        remote: remote
          ? `${truncate(remote.name || '이름 없는 책갈피', 42)} · ${formatPercent(remote.progressPercent)}`
          : '삭제됨',
      };
    }
    if (kind === 'annotation') {
      const local = conflict.latestLocalPosition
        && 'rangeCfi' in conflict.latestLocalPosition
        ? conflict.latestLocalPosition
        : null;
      const remote = conflict.remoteHead && 'annotationId' in conflict.remoteHead
        ? conflict.remoteHead.annotation
        : null;
      const describe = (value: typeof local) => value
        ? `“${truncate(value.quote || '인용문 없음', 42)}” · ${value.colorId}${value.note ? ` · 메모: ${truncate(value.note, 32)}` : ''}`
        : '삭제됨';
      return { local: describe(local), remote: describe(remote) };
    }
    if (kind === 'palette') {
      const local = conflict.latestLocalPosition && 'items' in conflict.latestLocalPosition
        ? conflict.latestLocalPosition.items
        : [];
      const remote = conflict.remoteHead && 'palette' in conflict.remoteHead
        ? conflict.remoteHead.palette.items
        : [];
      const describe = (items: typeof local) => items.length > 0
        ? truncate(items.map(({ label, meaning }) => `${label}: ${meaning || '의미 미지정'}`).join(' · '), 100)
        : '기본 팔레트';
      return { local: describe(local), remote: describe(remote) };
    }
    return null;
  })();
  return (
  <div className="fixed inset-0 z-[130] flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm sm:p-6">
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="sync-conflict-title"
      aria-describedby="sync-conflict-description"
      aria-busy={resolving}
      tabIndex={-1}
      className={`max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl border p-5 shadow-2xl sm:p-6 ${theme.bg} ${theme.text} ${theme.border}`}
    >
      <h2 id="sync-conflict-title" className="text-xl font-black">동기화 충돌</h2>
      {bookTitle && <p className="mt-1 truncate text-sm font-bold opacity-70">{bookTitle}</p>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl border border-current/10 px-3 py-2 text-xs">
        <dt className="font-bold opacity-55">대상</dt>
        <dd className="font-bold">{targetLabel}</dd>
        <dt className="font-bold opacity-55">감지</dt>
        <dd>{formatConflictTime(conflict.createdAt)}</dd>
        {formatConflictTime(remoteChangedAt) && (
          <>
            <dt className="font-bold opacity-55">원격 기기 기록</dt>
            <dd>{formatConflictTime(remoteChangedAt)}</dd>
          </>
        )}
        {remoteServerTime && (
          <>
            <dt className="font-bold opacity-55">서버 반영</dt>
            <dd>{remoteServerTime}</dd>
          </>
        )}
      </dl>
      {comparison && (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border border-current/10 px-3 py-2 text-xs leading-5">
          <dt className="font-black text-accent-500">현재 기기</dt>
          <dd className="min-w-0 break-words">{comparison.local}</dd>
          <dt className="font-black opacity-60">원격 상태</dt>
          <dd className="min-w-0 break-words">{comparison.remote}</dd>
        </dl>
      )}
      <p id="sync-conflict-description" className="mt-3 text-sm leading-6 opacity-80">
        {conflict.conflictReason === 'annotation-duplicate-range'
          ? '같은 문장 범위의 하이라이트가 이미 원격에 있습니다.'
          : conflict.conflictReason === 'annotation-color-limit'
            ? '이 색상의 원격 하이라이트가 최대 20개에 도달했습니다.'
            : conflict.conflictReason === 'annotation-book-limit'
              ? '이 책의 원격 하이라이트가 최대 100개에 도달했습니다.'
              : conflict.conflictReason === 'annotation-aggregate-size'
                ? '이 책의 주석 데이터가 서버의 안전한 저장 용량에 도달했습니다.'
                : generationConflict
                  ? '다른 기기에서 이 책의 주석이 삭제된 뒤 새 동기화 세대가 시작됐습니다.'
              : remoteMissing && conflict.event?.target.kind === 'annotation'
          ? '원격에 해당 하이라이트·메모가 없습니다.'
          : remoteMissing && conflict.event?.target.kind === 'palette'
            ? '원격에 저장된 형광펜 팔레트가 없습니다.'
            : `${targetLabel}가 다른 기기나 앱 세션에서도 변경됐습니다.`}
        {existingPolicyTarget
          ? ' 현재 변경을 취소하고 원격 상태로 되돌릴 수 있습니다.'
          : capacityConflict
            ? ' 서버 제한을 지키려면 이 기기에서 추가한 항목을 삭제해야 합니다.'
            : generationConflict
              ? ' 삭제 전 변경을 버리거나, 현재 동기화 세대에 명시적으로 다시 저장할 수 있습니다.'
          : ' 어느 값을 유지할지 선택할 때까지 이 항목의 원격 전송만 멈춥니다.'}
      </p>
      <p className="mt-2 text-xs leading-5 opacity-60">
        한쪽을 선택하면 이 대상의 반대쪽 변경은 덮어쓰거나 삭제될 수 있습니다. 나중에 결정하면 현재 상태를 그대로 두고 이 대상의 전송만 보류합니다.
      </p>
      {error && (
        <p role="alert" className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-bold text-amber-600 dark:text-amber-400">
          {error}
        </p>
      )}
      <div className="mt-6 grid gap-3">
        {!requiresRemoteResolution && (
          <button type="button" disabled={resolving} onClick={onKeepLocal} className="rounded-2xl bg-accent-500 px-4 py-3 font-bold text-white disabled:opacity-40">
            현재 기기 값 유지
          </button>
        )}
        <button type="button" disabled={resolving} onClick={onUseRemote} className={`rounded-2xl border px-4 py-3 font-bold disabled:opacity-40 ${theme.border} ${theme.secondary}`}>
          {remoteActionLabel}
        </button>
        <button type="button" disabled={resolving} onClick={onDefer} className="rounded-2xl px-4 py-3 text-sm font-bold opacity-60 hover:opacity-100 disabled:opacity-30">
          나중에 결정
        </button>
      </div>
    </div>
  </div>
  );
};
