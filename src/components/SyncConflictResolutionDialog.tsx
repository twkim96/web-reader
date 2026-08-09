import type { ThemeClasses } from '../types';
import type { SyncConflictV5 } from '../lib/syncOutboxV5';

type Props = {
  conflict: SyncConflictV5;
  theme: ThemeClasses;
  onKeepLocal: () => void;
  onUseRemote: () => void;
  onDefer: () => void;
  bookTitle?: string;
  resolving?: boolean;
};

export const SyncConflictResolutionDialog = ({
  conflict,
  theme,
  onKeepLocal,
  onUseRemote,
  onDefer,
  bookTitle,
  resolving = false,
}: Props) => {
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
  return (
  <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
    <div aria-busy={resolving} className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${theme.bg} ${theme.text} ${theme.border}`}>
      <h2 className="text-xl font-black">동기화 충돌</h2>
      {bookTitle && <p className="mt-1 truncate text-sm font-bold opacity-70">{bookTitle}</p>}
      {localProgressPercent !== null && remoteProgressPercent !== null && (
        <p className="mt-3 rounded-xl border border-current/10 px-3 py-2 text-sm font-bold">
          현재 위치 {localProgressPercent.toFixed(1)}% · 클라우드 {remoteProgressPercent.toFixed(1)}%
        </p>
      )}
      <p className="mt-3 text-sm leading-6 opacity-80">
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
