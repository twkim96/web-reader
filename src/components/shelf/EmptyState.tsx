import React from 'react';
import { XCircle } from 'lucide-react';
import { ThemeClasses } from '../../types';

interface EmptyStateProps {
  searchKeyword: string;
  isOfflineMode: boolean;
  isGuest: boolean;
  theme: ThemeClasses;
  onClearSearch: () => void;
  onToggleCloud: () => void;
  onLogin: () => void;
  onShowImportConfirm: () => void;
  onAddSampleBook: () => void;
  isAddingSampleBook: boolean;
  sampleBookFeedback: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  searchKeyword,
  isOfflineMode,
  isGuest,
  theme,
  onClearSearch,
  onToggleCloud,
  onLogin,
  onShowImportConfirm,
  onAddSampleBook,
  isAddingSampleBook,
  sampleBookFeedback,
}) => {
  const linkClass = 'inline border-0 bg-transparent p-0 font-semibold underline decoration-1 underline-offset-4 transition-opacity hover:opacity-100 disabled:cursor-wait disabled:opacity-45';

  return (
    <div data-empty-shelf-panel="true" className="flex min-h-[60dvh] flex-col items-center justify-center px-6 py-24 text-center">
      {searchKeyword ? (
        <>
          <div className={`p-8 ${theme.secondary} rounded-[2rem] opacity-60`}>
            <XCircle size={64} />
          </div>
          <div className="space-y-2">
            <h3 className="text-xl font-bold">검색 결과가 없습니다</h3>
            <p className="opacity-60 text-sm">&ldquo;{searchKeyword}&rdquo;</p>
          </div>
          <button 
            onClick={onClearSearch} 
            className="px-8 py-3 bg-accent-600 text-white rounded-full font-bold text-xs uppercase hover:bg-accent-500 transition-all"
          >
            전체 목록 보기
          </button>
        </>
      ) : (
        <div className="max-w-[min(90vw,48rem)] space-y-2 opacity-65">
          <h3 data-empty-shelf-heading="true" className="text-lg font-bold">보관함이 비어있음.</h3>
          <p className="text-sm font-medium leading-relaxed">
            {isGuest ? (
              <>
                <span data-empty-shelf-copy-line="first" className="block whitespace-nowrap">
                  책을 보관함에 추가하려면{' '}
                  <button type="button" onClick={onLogin} data-empty-shelf-action="google" className={linkClass}>
                    Google 계정을 연동
                  </button>
                </span>
                <span data-empty-shelf-copy-line="second" className="block whitespace-nowrap">
                  하거나{' '}
                  <button
                    type="button"
                    onClick={onAddSampleBook}
                    disabled={isAddingSampleBook}
                    data-empty-shelf-action="sample"
                    className={linkClass}
                  >
                    샘플 도서를 추가
                  </button>해주세요
                </span>
              </>
            ) : isOfflineMode ? (
              <>
                <span data-empty-shelf-copy-line="first" className="block whitespace-nowrap">
                  책을 보관함에 추가하려면{' '}
                  <button type="button" onClick={onToggleCloud} data-empty-shelf-action="cloud" className={linkClass}>
                    드라이브에 로그인
                  </button>
                </span>
                <span data-empty-shelf-copy-line="second" className="block whitespace-nowrap">
                  하거나{' '}
                  <button type="button" onClick={onShowImportConfirm} data-empty-shelf-action="import" className={linkClass}>
                    파일을 로컬에 업로드
                  </button>해주세요
                </span>
              </>
            ) : (
              <>
                책을 보관함에 추가하려면{' '}
                <button type="button" onClick={onShowImportConfirm} data-empty-shelf-action="drive" className={linkClass}>
                  파일을 드라이브에 업로드
                </button>해주세요
              </>
            )}
            .
          </p>
          {isGuest && sampleBookFeedback && (
            <p role="status" className="pt-2 text-xs font-bold opacity-80">
              {sampleBookFeedback}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
