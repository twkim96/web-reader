import type { ThemeClasses } from '../types';
import type { SyncConflictV5 } from '../lib/syncOutboxV5';

type Props = {
  conflict: SyncConflictV5;
  theme: ThemeClasses;
  onKeepLocal: () => void;
  onUseRemote: () => void;
  onDefer: () => void;
};

export const SyncConflictResolutionDialog = ({
  conflict,
  theme,
  onKeepLocal,
  onUseRemote,
  onDefer,
}: Props) => {
  const targetLabel = conflict.event?.target.kind === 'bookmark'
    ? '북마크'
    : conflict.event?.target.kind === 'annotation'
      ? '하이라이트·메모'
      : conflict.event?.target.kind === 'palette'
        ? '형광펜 팔레트'
        : '읽기 위치';
  const remoteMissing = conflict.remoteHead === null;
  const aggregateConflict = conflict.conflictReason !== undefined;
  const existingAggregateTarget = aggregateConflict && conflict.remoteHead !== null;
  const remoteActionLabel = existingAggregateTarget
    ? conflict.conflictReason === 'annotation-color-limit'
      ? '원격 색상 유지'
      : '원격 상태로 되돌리기'
    : conflict.conflictReason === 'annotation-duplicate-range'
    ? '이 기기의 중복 하이라이트 삭제'
    : aggregateConflict
      ? '이 기기의 추가 하이라이트 삭제'
    : remoteMissing && conflict.event?.target.kind === 'annotation'
    ? '원격에서 삭제됨 — 이 기기에서도 삭제'
    : remoteMissing && conflict.event?.target.kind === 'palette'
      ? '원격 설정 없음 — 기본 팔레트로 초기화'
      : '원격 값 사용';
  return (
  <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
    <div className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${theme.bg} ${theme.text} ${theme.border}`}>
      <h2 className="text-xl font-black">동기화 충돌</h2>
      <p className="mt-3 text-sm leading-6 opacity-80">
        {conflict.conflictReason === 'annotation-duplicate-range'
          ? '같은 문장 범위의 하이라이트가 이미 원격에 있습니다.'
          : conflict.conflictReason === 'annotation-color-limit'
            ? '이 색상의 원격 하이라이트가 최대 20개에 도달했습니다.'
            : conflict.conflictReason === 'annotation-book-limit'
              ? '이 책의 원격 하이라이트가 최대 100개에 도달했습니다.'
              : remoteMissing && conflict.event?.target.kind === 'annotation'
          ? '원격에 해당 하이라이트·메모가 없습니다.'
          : remoteMissing && conflict.event?.target.kind === 'palette'
            ? '원격에 저장된 형광펜 팔레트가 없습니다.'
            : `${targetLabel}가 다른 기기나 앱 세션에서도 변경됐습니다.`}
        {existingAggregateTarget
          ? ' 현재 변경을 취소하고 원격 상태로 되돌릴 수 있습니다.'
          : aggregateConflict
            ? ' 서버 제한을 지키려면 이 기기에서 추가한 항목을 삭제해야 합니다.'
          : ' 어느 값을 유지할지 선택할 때까지 이 항목의 원격 전송만 멈춥니다.'}
      </p>
      <div className="mt-6 grid gap-3">
        {!aggregateConflict && (
          <button type="button" onClick={onKeepLocal} className="rounded-2xl bg-accent-500 px-4 py-3 font-bold text-white">
            현재 기기 값 유지
          </button>
        )}
        <button type="button" onClick={onUseRemote} className={`rounded-2xl border px-4 py-3 font-bold ${theme.border} ${theme.secondary}`}>
          {remoteActionLabel}
        </button>
        <button type="button" onClick={onDefer} className="rounded-2xl px-4 py-3 text-sm font-bold opacity-60 hover:opacity-100">
          나중에 결정
        </button>
      </div>
    </div>
  </div>
  );
};
