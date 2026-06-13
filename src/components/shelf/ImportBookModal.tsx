import React, { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { FileText, Plus, X } from 'lucide-react';
import {
  ACTIVE_IMPORT_ACCEPT,
  EXTENDED_IMPORT_FORMATS_ENABLED,
  GENERAL_FILE_MAX_BYTES,
  GENERAL_TOTAL_MAX_BYTES,
  updateImportSelection,
} from '../../lib/bookFormats';

interface ImportBookModalProps {
  theme: { bg: string; text: string; border: string; secondary: string };
  isOfflineMode: boolean;
  isGuest: boolean;
  maxFiles: number;
  onClose: () => void;
  onConfirm: (files: File[]) => void;
  onLogin: () => void;
  onToggleCloud: () => void;
}

const BYTES_PER_MB = 1024 * 1024;

const formatFileSize = (bytes: number) => `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;

export const ImportBookModal: React.FC<ImportBookModalProps> = ({
  theme,
  isOfflineMode,
  isGuest,
  maxFiles,
  onClose,
  onConfirm,
  onLogin,
  onToggleCloud,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFilesToList = (files: FileList | File[]) => {
    const incomingFiles = Array.from(files);
    if (incomingFiles.length === 0) return;

    const result = updateImportSelection(selectedFiles, incomingFiles, {
      allowExtendedFormats: EXTENDED_IMPORT_FORMATS_ENABLED,
      maxFiles,
    });
    if (result.error) {
      alert(result.error);
      return;
    }

    setSelectedFiles(result.files);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);

    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;

    addFilesToList(files);
  };

  const handleDrag = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      addFilesToList(files);
    }
    event.target.value = '';
  };

  const removeSelectedFile = (targetIndex: number) => {
    setSelectedFiles((currentFiles) => currentFiles.filter((_, index) => index !== targetIndex));
  };

  const handleConfirm = () => {
    if (selectedFiles.length === 0) {
      alert('추가할 도서 파일을 먼저 선택해 주세요.');
      return;
    }

    onConfirm(selectedFiles);
    onClose();
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
        <input
          ref={fileInputRef}
          type="file"
          accept={ACTIVE_IMPORT_ACCEPT}
          multiple
          className="hidden"
          onClick={(event) => event.stopPropagation()}
          onChange={handleFileInputChange}
        />

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

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
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
          className={`flex h-[8.25rem] w-full flex-col items-center justify-center gap-2.5 rounded-3xl border-2 border-dashed px-4 text-center transition-all ${
            isDragging
              ? 'border-accent-400 bg-accent-500/15 text-accent-300'
              : `${theme.border} bg-white/5 hover:bg-white/10`
          }`}
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-400">
            <Plus size={27} strokeWidth={2.6} />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-black">파일 선택 또는 여기로 드래그</p>
            <p className="text-[11px] font-bold opacity-60">
              .txt, .epub / 최대 {maxFiles}개 / 파일 {GENERAL_FILE_MAX_BYTES / BYTES_PER_MB}MB / 총 {GENERAL_TOTAL_MAX_BYTES / BYTES_PER_MB}MB
            </p>
          </div>
        </button>

        <div className={`border-t ${theme.border} pt-4`}>
          <div className="mb-3 flex items-center justify-between text-[11px] font-black uppercase tracking-[0.12em] opacity-60">
            <span>선택한 도서</span>
            <span>{selectedFiles.length}/{maxFiles}</span>
          </div>
          {selectedFiles.length > 0 ? (
            <div className="h-[11.25rem] space-y-2 overflow-y-auto pr-1">
              {selectedFiles.map((file, index) => (
                <div
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  className="flex h-14 items-center gap-3 rounded-2xl bg-white/5 px-3"
                >
                  <FileText size={16} className="shrink-0 text-accent-400" />
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate text-xs font-black">{file.name}</p>
                    <p className="text-[10px] font-bold opacity-50">{formatFileSize(file.size)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeSelectedFile(index)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-white/5 opacity-70 transition-all hover:bg-white/10 hover:opacity-100 active:scale-95"
                    aria-label={`${file.name} 제거`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-white/5 px-4 py-5 text-center text-xs font-bold opacity-55">
              아직 선택한 도서가 없습니다.
            </div>
          )}
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-white/5 hover:bg-white/10 font-bold rounded-2xl text-sm transition-colors active:scale-95"
          >
            취소
          </button>
          <button
            onClick={handleConfirm}
            className="flex flex-1 items-center justify-center gap-2 py-3 font-bold rounded-2xl text-sm transition-all active:scale-95 text-white shadow-lg bg-accent-600 hover:bg-accent-500 shadow-accent-500/20 disabled:cursor-not-allowed disabled:opacity-45"
            disabled={selectedFiles.length === 0}
          >
            <span>추가</span>
          </button>
        </div>
      </div>
    </div>
  );
};
