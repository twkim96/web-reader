// src/components/BookmarkModal.tsx
import React from 'react';
import { Bookmark } from '../types';
import { X, Trash2, Bookmark as BookmarkIcon, History } from 'lucide-react';

interface BookmarkModalProps {
  bookmarks: Bookmark[];
  theme: { bg: string; text: string; border: string };
  onClose: () => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  onJump: (idx: number) => void;
  totalLength: number;
}

export const BookmarkModal: React.FC<BookmarkModalProps> = ({
  bookmarks, theme, onClose, onAdd, onDelete, onJump, totalLength
}) => {
  const manualBookmarks = bookmarks.filter(b => b.type === 'manual').sort((a, b) => b.createdAt - a.createdAt);
  const autoBookmark = bookmarks.find(b => b.type === 'auto');

  const getPercent = (charIndex: number) => {
    const p = (charIndex / Math.max(1, totalLength)) * 100;
    return p.toFixed(2);
  };

  return (
    <div 
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center sm:p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose} 
    >
      <div 
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md h-[80vh] sm:h-auto sm:max-h-[80vh] ${theme.bg} ${theme.text} rounded-t-3xl sm:rounded-3xl shadow-2xl border ${theme.border} flex flex-col animate-in slide-in-from-bottom-10 duration-300`}
      >
        {/* Header */}
        <div className={`flex items-center justify-between p-5 border-b ${theme.border}`}>
          <div className="flex items-center gap-2">
            <BookmarkIcon className="text-indigo-500" size={20} />
            <h2 className="font-bold text-lg">책갈피</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          
          {/* 1. 수동 추가 버튼 */}
          <div className="space-y-2">
            <div className="flex justify-between items-end mb-2">
              <span className="text-xs font-bold opacity-50 uppercase tracking-wider">나만의 책갈피 ({manualBookmarks.length}/5)</span>
            </div>
            
            <button 
              onClick={onAdd}
              disabled={manualBookmarks.length >= 5}
              className={`w-full py-4 rounded-2xl border-2 border-dashed flex items-center justify-center gap-2 font-bold transition-all
                ${manualBookmarks.length >= 5 
                  ? 'border-gray-500/20 text-gray-500/40 cursor-not-allowed' 
                  : `border-indigo-500/30 text-indigo-500 hover:bg-indigo-500/5 active:scale-95`
                }`}
            >
              {manualBookmarks.length >= 5 ? '슬롯이 가득 찼습니다' : '+ 현재 위치 추가하기'}
            </button>

            {/* 수동 책갈피 리스트 */}
            <div className="space-y-3 mt-4">
              {manualBookmarks.map((bm) => (
                <div key={bm.id} className="relative group">
                  <button 
                    onClick={() => onJump(bm.charIndex)}
                    className={`w-full p-4 rounded-2xl text-left transition-transform active:scale-95 border border-white/5 bg-white/5 hover:bg-white/10 overflow-hidden flex gap-4`}
                  >
                    <div className={`w-1.5 self-stretch rounded-full ${bm.color}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-serif leading-relaxed line-clamp-2 opacity-90">"{bm.name}"</p>
                      
                      {/* [Modified] 날짜/퍼센트 표시 개선 */}
                      <p className="text-[10px] mt-2.5 font-sans flex items-center gap-2">
                        <span className="opacity-40">{new Date(bm.createdAt).toLocaleString()}</span>
                        <span className="w-1 h-1 rounded-full bg-current opacity-20" />
                        {/* 잘 보이게 수정된 퍼센트 태그 */}
                        <span className="font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded text-[11px]">
                          {getPercent(bm.charIndex)}%
                        </span>
                      </p>
                    </div>
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); onDelete(bm.id); }}
                    className="absolute top-1/2 -translate-y-1/2 right-4 p-2 text-red-400 opacity-60 hover:opacity-100 bg-black/20 rounded-full"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
              {manualBookmarks.length === 0 && (
                <p className="text-center text-xs opacity-30 py-4">저장된 책갈피가 없습니다.</p>
              )}
            </div>
          </div>

          <hr className={`border-dashed ${theme.border} opacity-50`} />

          {/* 2. 자동 책갈피 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <History size={14} className="opacity-50" />
              <span className="text-xs font-bold opacity-50 uppercase tracking-wider">자동 저장 (최근 이동 전 위치)</span>
            </div>
            
            {autoBookmark ? (
              <button 
                onClick={() => onJump(autoBookmark.charIndex)}
                className={`w-full p-4 rounded-2xl text-left transition-transform active:scale-95 border border-white/5 bg-white/5 hover:bg-white/10 flex gap-4`}
              >
                <div className={`w-1.5 self-stretch rounded-full bg-slate-500`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-serif leading-relaxed line-clamp-2 opacity-90">"{autoBookmark.name}"</p>
                  
                  {/* [Modified] 날짜/퍼센트 표시 개선 */}
                  <p className="text-[10px] mt-2.5 font-sans flex items-center gap-2">
                    <span className="opacity-40">{new Date(autoBookmark.createdAt).toLocaleString()}</span>
                    <span className="w-1 h-1 rounded-full bg-current opacity-20" />
                    {/* 잘 보이게 수정된 퍼센트 태그 */}
                    <span className="font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded text-[11px]">
                      {getPercent(autoBookmark.charIndex)}%
                    </span>
                  </p>
                </div>
              </button>
            ) : (
              <p className="text-center text-xs opacity-30 py-4 bg-black/5 rounded-2xl">대량 이동 시 자동으로 생성됩니다.</p>
            )}
          </div>

        </div>
      </div>
    </div>
  );
};