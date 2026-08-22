import React, { useEffect } from 'react';
import { Database, HardDrive, ShieldCheck, X } from 'lucide-react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface LoginDisclosureModalProps {
  theme: {
    bg: string;
    text: string;
    border: string;
    secondary: string;
  };
  onClose: () => void;
  onSignIn: () => void;
}

export const LoginDisclosureModal: React.FC<LoginDisclosureModalProps> = ({
  theme,
  onClose,
  onSignIn,
}) => {
  useBodyScrollLock();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        data-login-disclosure-modal="true"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-disclosure-title"
        className={`flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl border shadow-2xl ${theme.bg} ${theme.text} ${theme.border}`}
      >
        <header className={`flex shrink-0 items-center gap-3 border-b px-4 py-3 ${theme.border}`}>
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${theme.secondary}`}>
            <ShieldCheck size={21} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="login-disclosure-title" className="text-base font-black">개인정보 처리방침</h2>
            <p className="mt-0.5 text-[11px] font-bold opacity-55">Google 로그인과 Drive 연결은 서로 다른 권한입니다.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="로그인 안내 닫기"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X size={21} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <button
            type="button"
            data-login-disclosure-confirm="true"
            onClick={onSignIn}
            className="min-h-13 w-full rounded-2xl bg-accent-600 px-4 text-sm font-bold text-white shadow-lg shadow-accent-500/20 transition-colors hover:bg-accent-500"
          >
            Sign in with Google
          </button>
          <p className="mt-2 text-center text-[10px] font-semibold leading-relaxed opacity-50">
            계속하면 아래의 로그인 정보 처리 내용을 확인하고 동의한 것으로 간주합니다.
          </p>

          <div data-login-disclosure-notice="true" className={`mt-4 border-t pt-4 ${theme.border}`}>
            <h3 className="text-[11px] font-black opacity-65">개인정보 고지사항</h3>

            <section className="mt-3">
              <div className="mb-1.5 flex items-center gap-1.5 opacity-70">
                <Database size={14} aria-hidden="true" />
                <h4 className="text-[11px] font-black">Firebase 계정 로그인</h4>
              </div>
              <ul className="space-y-1 text-[10px] font-semibold leading-[1.55] opacity-55">
                <li>• Google 계정의 고유 식별자, 이메일, 이름과 프로필 사진이 Firebase 인증을 통해 제공될 수 있습니다.</li>
                <li>• 고유 식별자와 이메일은 계정 구분·표시에 사용하며, 독서 진행률·책갈피·주석·독서 통계를 해당 계정의 Firestore 영역에 동기화합니다.</li>
                <li>• Google 비밀번호와 도서 원본은 Firebase에 저장하지 않습니다.</li>
              </ul>
            </section>

            <section className="mt-4">
              <div className="mb-1.5 flex items-center gap-1.5 opacity-70">
                <HardDrive size={14} aria-hidden="true" />
                <h4 className="text-[11px] font-black">Google Drive 연결 (선택)</h4>
              </div>
              <ul className="space-y-1 text-[10px] font-semibold leading-[1.55] opacity-55">
                <li>• 로그인 후 클라우드 연결을 선택할 때 별도의 Drive 동의를 요청합니다.</li>
                <li>• 읽기 권한은 책장 폴더와 도서를 찾고 불러오는 데, 쓰기 권한은 앱이 만들거나 연 파일을 관리하는 데 사용합니다.</li>
                <li>• 숨겨진 앱 데이터에는 책장 폴더 식별 정보만 저장합니다.</li>
                <li>• Drive 접근 토큰은 현재 탭의 세션 저장소와 메모리에만 보관하며 만료·연결 해제 시 제거합니다.</li>
              </ul>
            </section>
          </div>
        </div>

        <footer className={`shrink-0 border-t p-4 ${theme.border}`}>
          <button
            type="button"
            data-login-disclosure-cancel="true"
            onClick={onClose}
            className={`min-h-11 w-full rounded-2xl border px-4 text-sm font-bold transition-colors hover:brightness-110 ${theme.border} ${theme.secondary}`}
          >
            취소
          </button>
        </footer>
      </section>
    </div>
  );
};
