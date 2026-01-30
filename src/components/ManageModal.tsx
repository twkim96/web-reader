// src/components/ManageModal.tsx
import React, { useEffect, useState } from 'react';
// [Fixed] 올바른 함수명으로 import 수정
import { getAllOfflineBooks, removeBookFromLocal } from '../lib/localDB';
import { Trash2, HardDrive, X, FileText } from 'lucide-react';

interface ManageModalProps {
  onClose: () => void;
  onUpdate: () => void;
  theme: any;
}

export const ManageModal: React.FC<ManageModalProps> = ({ onClose, onUpdate, theme }) => {
  const [books, setBooks] = useState<{ id: string; name: string; size: number }[]>([]);

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
    if (confirm("이 도서를 로컬 저장소에서 삭제하시겠습니까?")) {
      // [Fixed] 변경된 함수 사용
      await removeBookFromLocal(id);
      await loadBooks();
      onUpdate();
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes) return 'Unknown Size';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6" onClick={onClose}>
      <div 
        className="w-full max-w-md bg-[#0f172a] text-slate-200 rounded-[2rem] shadow-2xl border border-white/10 overflow-hidden flex flex-col max-h-[80vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 border-b border-white/10 flex items-center justify-between bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-600 rounded-xl">
              <HardDrive size={20} className="text-white" />
            </div>
            <h2 className="font-black text-lg uppercase italic tracking-tight">Offline Storage</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {books.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-500 gap-4 opacity-50">
              <HardDrive size={48} strokeWidth={1} />
              <p className="text-xs font-bold uppercase tracking-widest">No Downloads</p>
            </div>
          ) : (
            books.map((book) => (
              <div key={book.id} className="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5 hover:border-indigo-500/30 transition-colors group">
                <div className="flex items-center gap-4 overflow-hidden">
                  <FileText className="text-indigo-400 shrink-0" size={20} />
                  <div className="min-w-0">
                    <h3 className="font-bold text-sm truncate text-white">{book.name.replace('.txt', '')}</h3>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">{formatSize(book.size)}</p>
                  </div>
                </div>
                <button 
                  onClick={() => handleDelete(book.id)}
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
    </div>
  );
};