import type { ThemeClasses } from '../types';
import type { LegacyInventory } from '../lib/localDBMigration';

type LegacyMigrationDialogProps = {
  inventory: LegacyInventory;
  previousError?: string;
  theme: ThemeClasses;
  onChoose: (choice: 'migrate' | 'legacy-readonly' | 'empty') => void;
};

export const LegacyMigrationDialog = ({
  inventory,
  previousError,
  theme,
  onChoose,
}: LegacyMigrationDialogProps) => {
  const bookCount = Math.max(inventory.counts.books, inventory.counts.metadata);
  const size = inventory.contentBytes > 0
    ? `${(inventory.contentBytes / 1024 / 1024).toFixed(1)} MB`
    : '크기 정보 없음';

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl ${theme.bg} ${theme.text} ${theme.border}`}>
        <h2 className="text-xl font-black">기존 로컬 서재를 확인했습니다</h2>
        <p className="mt-3 text-sm leading-6 opacity-80">
          기존 데이터 {bookCount}권 · {size}를 현재 계정 서재로 안전하게 복사할 수 있습니다.
          원본은 어떤 선택에서도 삭제되지 않습니다.
        </p>
        {previousError && (
          <p className="mt-3 rounded-xl bg-red-500/10 p-3 text-xs text-red-400">
            이전 시도 실패: {previousError}
          </p>
        )}
        <div className="mt-6 grid gap-3">
          <button
            type="button"
            className="rounded-2xl bg-accent-500 px-4 py-3 font-bold text-white"
            onClick={() => onChoose('migrate')}
          >
            현재 계정으로 데이터 이전
          </button>
          <button
            type="button"
            className={`rounded-2xl border px-4 py-3 font-bold ${theme.border} ${theme.secondary}`}
            onClick={() => onChoose('legacy-readonly')}
          >
            기존 서재를 읽기 전용으로 열기
          </button>
          <button
            type="button"
            className="rounded-2xl px-4 py-3 text-sm font-bold opacity-60 hover:opacity-100"
            onClick={() => onChoose('empty')}
          >
            기존 데이터는 보존하고 빈 서재로 시작
          </button>
        </div>
      </div>
    </div>
  );
};
