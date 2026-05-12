// src/components/ManageModal.tsx
import React, { useEffect, useState } from 'react';
// [Fixed] 올바른 함수명으로 import 수정
import { getAllOfflineBooks, removeBookFromLocal } from '../lib/localDB';
import { Trash2, HardDrive, X, FileText } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';

interface ManageModalProps {
  onClose: () => void;
  onUpdate: () => void;
  theme: any;
}

export const ManageModal: React.FC<ManageModalProps> = ({ onClose, onUpdate, theme }) => {
  const [books, setBooks] = useState<{ id: string; name: string; size: number }[]>([]);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const loadBooks = async () => {
    const data = await getAllOfflineBooks();
    // [Modified] 이제 data에 size 정보가 포함되어 있음 (내용을 로드하지 않아 빠름)
    setBooks(data.map(b => ({
      id: b.id,
      name: b.name,
      size: b.size || 0
    })));
  };

  useEffect(() => { loadBooks(); }, []);

  const handleDelete = async (id: string) => {
    await removeBookFromLocal(id);
    await loadBooks();
    onUpdate();
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return 'Unknown Size';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={onClose}>
      <div
        className={`w-full max-w-md ${theme.bg} ${theme.text} rounded-[2rem] shadow-2xl border ${theme.border} overflow-hidden flex flex-col max-h-[80vh] transition-colors duration-300`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`p-6 border-b ${theme.border} flex items-center justify-between ${theme.secondary} opacity-90 transition-colors duration-300`}>
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-accent-600 rounded-xl">
              <HardDrive size={20} className="text-white" />
            </div>
            <h2 className="font-black text-lg uppercase italic tracking-tight">Offline Storage</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {books.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 opacity-30 gap-4 text-center px-4">
              <HardDrive size={48} strokeWidth={1} />
              <p className="text-xs font-bold uppercase tracking-widest">
                구글 드라이브에 <span className="text-accent-500 font-black">"web viewer"</span> 폴더를 생성하고, 읽고 싶은 <span className="text-accent-500 font-black">.epub</span> 또는 <span className="text-accent-500 font-black">.txt</span> 파일을 업로드해 주세요.
              </p>
            </div>
          ) : (
            books.map((book) => (
              <div key={book.id} className={`flex items-center justify-between p-4 ${theme.secondary} rounded-2xl border ${theme.border} hover:border-accent-500/30 transition-all group`}>
                <div className="flex items-center gap-4 overflow-hidden">
                  <FileText className="text-accent-400 shrink-0" size={20} />
                  <div className="min-w-0">
                    <h3 className="font-bold text-sm truncate">{book.name.normalize('NFC').replace(/\.epub$/i, '').replace(/\.txt$/i, '')}</h3>
                    <p className="text-[10px] opacity-60 font-bold uppercase tracking-wider">{formatSize(book.size)}</p>
                  </div>
                </div>
                <button
                  onClick={() => setPendingDeleteId(book.id)}
                  className="p-2.5 text-slate-500 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-all active:scale-95"
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