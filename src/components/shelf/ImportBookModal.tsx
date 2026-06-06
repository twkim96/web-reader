import React, { useState } from 'react';
import { Plus, Upload } from 'lucide-react';

interface ImportBookModalProps {
  theme: { bg: string; text: string; border: string; secondary: string };
  isOfflineMode: boolean;
  isGuest: boolean;
  maxFiles: number;
  onClose: () => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onUploadClick: () => void;
  onLogin: () => void;
  onToggleCloud: () => void;
}

export const ImportBookModal: React.FC<ImportBookModalProps> = ({
  theme,
  isOfflineMode,
  isGuest,
  maxFiles,
  onClose,
  onFilesSelected,
  onUploadClick,
  onLogin,
  onToggleCloud,
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;

    onFilesSelected(files);
    onClose();
  };

  const handleDrag = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleUploadClick = () => {
    onClose();
    onUploadClick();
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`w-full max-w-sm ${theme.bg} ${theme.text} rounded-3xl p-6 shadow-2xl border ${theme.border} animate-in zoom-in-95 duration-200 space-y-5`}
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className="p-3 rounded-2xl bg-accent-500/10 text-accent-400">
            <div className="w-5.5 h-5.5 border-2 border-current rounded-full flex items-center justify-center font-black text-xs">!</div>
          </div>
          <p className="text-sm font-bold leading-relaxed">도서를 라이브러리에 추가하시겠습니까?</p>
          <p className="text-xs font-bold opacity-80 leading-relaxed">
            {isOfflineMode ? (
              <span>
                선택한 도서가 내 기기에 저장됩니다. 원활한 동기화를 위해{' '}
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose();
                    if (isGuest) onLogin();
                    else onToggleCloud();
                  }}
                  className="text-accent-500 underline decoration-accent-500/50 underline-offset-2 hover:text-accent-400 font-black cursor-pointer"
                >
                  {isGuest ? '클라우드 로그인' : '클라우드 서비스 연결'}
                </button>
                {' '}후 추가하는 것을 추천합니다.
              </span>
            ) : (
              "선택한 도서가 내 기기에 저장되며, 구글 드라이브의 'web viewer' 폴더로 자동 업로드됩니다."
            )}
          </p>
        </div>

        <div
          onDrop={handleDrop}
          onDragEnter={(event) => {
            handleDrag(event);
            setIsDragging(true);
          }}
          onDragOver={handleDrag}
          onDragLeave={(event) => {
            handleDrag(event);
            setIsDragging(false);
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-5 py-7 text-center transition-all ${
            isDragging
              ? 'border-accent-400 bg-accent-500/15 text-accent-300'
              : `${theme.border} bg-white/5 hover:bg-white/10`
          }`}
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-400">
            <Plus size={34} strokeWidth={2.6} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-black">여기에 도서 파일을 놓기</p>
            <p className="text-[11px] font-bold opacity-60">.txt, .epub / 최대 {maxFiles}개</p>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-white/5 hover:bg-white/10 font-bold rounded-2xl text-sm transition-colors active:scale-95"
          >
            취소
          </button>
          <button
            onClick={handleUploadClick}
            className="flex flex-1 items-center justify-center gap-2 py-3 font-bold rounded-2xl text-sm transition-all active:scale-95 text-white shadow-lg bg-accent-600 hover:bg-accent-500 shadow-accent-500/20"
          >
            <Upload size={17} />
            <span>업로드</span>
          </button>
        </div>
      </div>
    </div>
  );
};
