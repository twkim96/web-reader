// src/components/ShelfSearchModal.tsx
import React, { useState } from 'react';
import { Search, X, ArrowRight } from 'lucide-react';

interface ShelfSearchModalProps {
  onClose: () => void;
  onSearch: (keyword: string) => void;
  initialKeyword: string;
}

export const ShelfSearchModal: React.FC<ShelfSearchModalProps> = ({ 
  onClose, 
  onSearch,
  initialKeyword 
}) => {
  const [keyword, setKeyword] = useState(initialKeyword);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(keyword);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[110] bg-[#0f172a]/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 animate-in fade-in duration-200">
      <div className="w-full max-w-md space-y-8 animate-in slide-in-from-bottom-10 duration-300">
        
        {/* 헤더 및 닫기 버튼 */}
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-black text-white italic uppercase tracking-tighter">
            Search Library
          </h2>
          <button 
            onClick={onClose}
            className="p-3 rounded-full bg-white/5 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X size={24} />
          </button>
        </div>

        {/* 검색 폼 */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-5 flex items-center pointer-events-none">
              <Search className="text-slate-500 group-focus-within:text-indigo-400 transition-colors" size={24} />
            </div>
            <input
              autoFocus
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="도서 제목 검색..."
              className="w-full bg-black/20 border-2 border-white/10 rounded-3xl py-6 pl-14 pr-6 text-lg text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500/50 focus:bg-black/30 transition-all font-bold"
            />
          </div>

          <div className="flex gap-3">
             {/* 초기화 버튼 (검색어가 있을 때만 표시) */}
             {keyword && (
              <button
                type="button"
                onClick={() => { setKeyword(''); onSearch(''); onClose(); }}
                className="px-6 py-4 rounded-2xl bg-white/5 text-slate-400 font-bold text-sm hover:bg-white/10 hover:text-white transition-colors"
              >
                초기화
              </button>
            )}
            
            <button
              type="submit"
              className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-2xl py-4 font-black uppercase tracking-widest text-sm shadow-lg shadow-indigo-500/20 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <span>Search</span>
              <ArrowRight size={18} />
            </button>
          </div>
        </form>

        <p className="text-center text-slate-500 text-xs font-medium">
          Enter 키를 누르면 검색이 시작됩니다.
        </p>
      </div>
    </div>
  );
};