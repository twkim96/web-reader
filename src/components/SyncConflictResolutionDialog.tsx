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
}: Props) => (
  <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
    <div className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl ${theme.bg} ${theme.text} ${theme.border}`}>
      <h2 className="text-xl font-black">동기화 충돌</h2>
      <p className="mt-3 text-sm leading-6 opacity-80">
        {conflict.event?.target.kind === 'bookmark' ? '북마크' : '읽기 위치'}가 다른 기기나 앱 세션에서도 변경됐습니다.
        어느 값을 유지할지 선택할 때까지 이 항목의 원격 전송만 멈춥니다.
      </p>
      <div className="mt-6 grid gap-3">
        <button type="button" onClick={onKeepLocal} className="rounded-2xl bg-accent-500 px-4 py-3 font-bold text-white">
          현재 기기 값 유지
        </button>
        <button type="button" onClick={onUseRemote} className={`rounded-2xl border px-4 py-3 font-bold ${theme.border} ${theme.secondary}`}>
          원격 값 사용
        </button>
        <button type="button" onClick={onDefer} className="rounded-2xl px-4 py-3 text-sm font-bold opacity-60 hover:opacity-100">
          나중에 결정
        </button>
      </div>
    </div>
  </div>
);
