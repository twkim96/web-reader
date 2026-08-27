// src/components/ManageModal.tsx
import React, { useEffect, useState } from 'react';
// [Fixed] 올바른 함수명으로 import 수정
import { getAllOfflineBooksV5, removeBookFromLocalV5 } from '../lib/localDBV5';
import { ownerRuntime } from '../lib/ownerRuntime';
import { DEVICE_CONTENT_OWNER_KEY } from '../lib/ownerIdentity';
import { Trash2, HardDrive, FileText } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { Book, ThemeClasses } from '../types';
import { getBookTitleFromFileName } from '../lib/bookFormats';
import { getBookFormatLabel } from './shelf/bookUtils';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { MenuSheetHeader } from './MenuSheetHeader';

interface ManageModalProps {
  onClose: () => void;
  onUpdate: () => void;
  theme: ThemeClasses;
}

export const ManageModal: React.FC<ManageModalProps> = ({ onClose, onUpdate, theme }) => {
  useBodyScrollLock();

  const [books, setBooks] = useState<(Book & { size: number })[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const loadBooks = async () => {
    const owner = ownerRuntime.require();
    const data = await getAllOfflineBooksV5(DEVICE_CONTENT_OWNER_KEY);
    if (!ownerRuntime.isCurrent(owner)) return;
    // [Modified] 이제 data에 size 정보가 포함되어 있음 (내용을 로드하지 않아 빠름)
    setBooks(data.map(b => ({
      id: b.id,
      name: b.name,
      mimeType: b.mimeType,
      sourceFormat: b.sourceFormat,
      readerFormat: b.readerFormat,
      archiveFormat: b.archiveFormat,
      size: Number(b.size) || 0,
    })));
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadBooks(), 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const handleDelete = async (id: string) => {
    const owner = ownerRuntime.require();
    await removeBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, id);
    if (!ownerRuntime.isCurrent(owner)) return;
    await loadBooks();
    onUpdate();
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return 'Unknown Size';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };

  return (
    <div data-menu-sheet-backdrop="true" className="app-menu-sheet-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={onClose}>
      <div
        data-menu-sheet="true"
        className={`app-panel-radius app-menu-sheet w-full max-w-md ${theme.bg} ${theme.text} shadow-2xl border ${theme.border} overflow-hidden flex flex-col max-h-[80vh] transition-colors duration-300`}
        onClick={e => e.stopPropagation()}
      >
        <MenuSheetHeader kind="offline-storage" title="Offline Storage" onClose={onClose} closeLabel="오프라인 저장소 닫기" borderClass={theme.border} secondaryClass={theme.secondary} />

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {books.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 opacity-30 gap-4 text-center px-4">
              <HardDrive size={48} strokeWidth={1} />
              <p className="text-xs font-bold uppercase tracking-widest">
                저장한 TXT, EPUB, PDF, ZIP, CBZ 또는 7Z 도서가 여기에 표시됩니다.
              </p>
            </div>
          ) : (
            books.map((book) => (
              <div key={book.id} className={`flex items-center justify-between p-4 ${theme.secondary} rounded-2xl border ${theme.border} hover:border-accent-500/30 transition-all group`}>
                <div className="flex items-center gap-4 overflow-hidden">
                  <FileText data-offline-book-icon="true" className="shrink-0 text-current" size={20} />
                  <div className="min-w-0">
                    <h3 className="font-bold text-sm truncate">{getBookTitleFromFileName(book.name)}</h3>
                    <p className="text-[10px] opacity-60 font-bold uppercase tracking-wider">
                      {getBookFormatLabel(book)} · {formatSize(book.size)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setPendingDeleteId(book.id)}
                  className="p-2.5 text-current opacity-55 hover:text-red-400 hover:opacity-100 hover:bg-red-500/10 rounded-xl transition-all active:scale-95"
                  title="Delete"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {pendingDeleteId && (
        <ConfirmDialog
          message="이 도서를 삭제하시겠습니까?"
          subMessage="로컬 저장소에서 영구 삭제됩니다."
          confirmLabel="삭제"
          theme={theme}
          onConfirm={async () => { await handleDelete(pendingDeleteId); setPendingDeleteId(null); }}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}
    </div>
  );
};
