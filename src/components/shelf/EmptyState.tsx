import React from 'react';
import { XCircle, WifiOff, FolderPlus, Library, FilePlus } from 'lucide-react';
import { ThemeClasses } from '../../types';

interface EmptyStateProps {
  searchKeyword: string;
  isOfflineMode: boolean;
  isGuest: boolean;
  theme: ThemeClasses;
  onClearSearch: () => void;
  onToggleCloud: () => void;
  onShowImportConfirm: () => void;
  onLogin: () => void;
  onRefresh: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  searchKeyword,
  isOfflineMode,
  isGuest,
  theme,
  onClearSearch,
  onToggleCloud,
  onShowImportConfirm,
  onLogin,
  onRefresh
}) => {
  return (
    <div className={`flex flex-col items-center justify-center py-32 text-center space-y-8 ${theme.secondary} rounded-[3.5rem] border ${theme.border} backdrop-blur-sm`}>
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
        <>
          <div className={`p-8 rounded-[2rem] shadow-inner ${isOfflineMode ? 'bg-slate-700/50 text-slate-400' : 'bg-accent-600/20 text-accent-400'}`}>
            {isOfflineMode ? <WifiOff size={64} /> : <FolderPlus size={64} />}
          </div>
          
          <div className="space-y-4 max-w-sm">
            {isOfflineMode ? (
              <>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter">
                  {isGuest ? 'Guest Library Empty' : 'Local Library Empty'}
                </h3>
                <div className="flex flex-col gap-3 items-center w-full mt-2">
                  {!isGuest && isOfflineMode && (
                    <button 
                      onClick={onToggleCloud} 
                      className="w-full max-w-[240px] py-4 bg-accent-600 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500 transition-all shadow-xl shadow-accent-500/20 active:scale-95 flex items-center justify-center gap-2"
                    >
                      <Library size={16} />
                      <span>Cloud Library 연결하기</span>
                    </button>
                  )}

                  <button 
                    onClick={onShowImportConfirm} 
                    className={`w-full max-w-[240px] py-4 rounded-full font-black text-[11px] uppercase tracking-widest transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2 ${
                      !isGuest && isOfflineMode 
                        ? `bg-white/5 border-2 ${theme.border} hover:bg-white/10 opacity-70` 
                        : "bg-accent-600 text-white hover:bg-accent-500"
                    }`}
                  >
                    <FilePlus size={16} />
                    <span>도서 직접 추가하기</span>
                  </button>

                  {isGuest && (
                    <button 
                      onClick={onLogin} 
                      className="text-[10px] font-bold text-accent-500/60 hover:text-accent-500 uppercase tracking-widest transition-colors"
                    >
                      또는 클라우드 계정으로 로그인하기
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <h3 className="text-2xl font-black italic uppercase tracking-tighter">No Books Found</h3>
                <p className="opacity-60 text-sm leading-relaxed font-medium">
                  구글 드라이브에 <span className="text-accent-500 font-black">&ldquo;web viewer&rdquo;</span> 폴더를 생성하고, 읽고 싶은 <span className="text-accent-500 font-black">.epub</span> 또는 <span className="text-accent-500 font-black">.txt</span> 파일을 업로드해 주세요.
                </p>
                <div className="flex flex-col gap-3 items-center w-full mt-2">
                  <button 
                    onClick={onShowImportConfirm} 
                    className="w-full max-w-[240px] py-4 bg-slate-700 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-slate-600 transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                  >
                    <FilePlus size={16} />
                    <span>도서 직접 추가하기</span>
                  </button>
                  <a 
                    href="https://drive.google.com/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className={`w-full max-w-[240px] py-4 border-2 border-accent-500/30 bg-accent-500/5 ${theme.text} rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500/10 transition-all flex items-center justify-center gap-3 active:scale-95 shadow-sm`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M7.74023 6L4.64023 11.38L8.60023 18.25L11.7002 12.87L7.74023 6Z" fill="#0066DA"/>
                      <path d="M21.5 13.5L15.3 13.5L12.21 18.82L15.41 24L21.5 13.5Z" fill="#0066DA" opacity="0"/>
                      <path d="M21.5002 13.5002L18.4002 18.8802L12.3002 18.8802L15.4002 13.5002L21.5002 13.5002Z" fill="#2684FF"/>
                      <path d="M12.3002 18.88L15.4002 13.5L8.60023 18.25L12.3002 18.88Z" fill="#0066DA" opacity="0"/>
                      <path d="M15.4002 13.5002L12.3002 8.12015L6.2002 8.12015L9.3002 13.5002L15.4002 13.5002Z" fill="#FFBC00"/>
                      <path d="M15.4002 13.5002L12.3002 8.12015L11.7002 12.87L15.4002 13.5002Z" fill="#0066DA" opacity="0"/>
                      <path d="M9.30023 13.5002L6.19022 18.8802L3.10022 13.5001L6.20023 8.12012L9.30023 13.5002Z" fill="#00AC47"/>
                      <path d="M6.2002 8.12012L9.3002 13.5002L12.3002 8.12012L9.2002 2.74012L3.1002 2.74012L6.2002 8.12012Z" fill="#EA4335" opacity="0"/>
                      <path d="M15.4002 2.74011L9.2002 2.74011L6.10022 8.12011L12.3002 8.12011L15.4002 2.74011Z" fill="#00AC47" opacity="0"/>
                      <path d="M9.3002 2.74011L3.2002 2.74011L6.2002 8.12011L9.3002 2.74011Z" fill="#0066DA" opacity="0"/>
                      <path d="M12.3002 8.12011L9.2002 2.74011L15.4002 2.74011L18.5002 8.12011L12.3002 8.12011Z" fill="#00AC47" opacity="0"/>
                      <path d="M15.41 12.87L18.51 8.12L12.41 8.12L9.31006 13.5L15.41 12.87Z" fill="#0066DA" opacity="0"/>
                      <path d="M18.5 8.12011L15.4 2.74011L9.3 2.74011L12.4 8.12011L18.5 8.12011Z" fill="#0066DA" opacity="0"/>
                    </svg>
                    <span>Open Google Drive</span>
                  </a>
                  <button 
                    onClick={onRefresh} 
                    className="w-full max-w-[240px] py-4 bg-accent-600 text-white rounded-full font-black text-[11px] uppercase tracking-widest hover:bg-accent-500 transition-all shadow-xl shadow-accent-500/20 active:scale-95"
                  >
                    Refresh Library
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};
