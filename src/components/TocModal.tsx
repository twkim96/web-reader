import React from 'react';
import { X, List } from 'lucide-react';

interface TocModalProps {
  toc: any[];
  theme: any;
  onClose: () => void;
  onJump: (href: string) => void;
  currentChapter?: string;
}

export const TocModal: React.FC<TocModalProps> = ({ toc, theme, onClose, onJump, currentChapter }) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className={`w-full max-w-md rounded-t-[2.5rem] ${theme.bg} ${theme.text} shadow-2xl flex flex-col max-h-[85vh] animate-in slide-in-from-bottom duration-300`}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-accent-500/10 rounded-xl text-accent-500">
              <List size={20} />
            </div>
            <div>
              <h3 className="font-bold tracking-tight">목차</h3>
              <p className="text-[10px] opacity-40 font-bold uppercase tracking-widest mt-0.5">Table of Contents</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors opacity-40 hover:opacity-100">
            <X size={20} />
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
          {toc.length === 0 ? (
            <div className="py-20 text-center opacity-30 text-xs font-bold uppercase tracking-widest">
              No Chapters Found
            </div>
          ) : (
            toc.map((item, idx) => (
              <button
                key={idx}
                onClick={() => onJump(item.href)}
                className={`w-full flex items-center justify-between p-4 rounded-2xl transition-all group ${
                  currentChapter === item.label 
                    ? 'bg-accent-500/10 text-accent-500' 
                    : 'hover:bg-white/5'
                }`}
              >
                <div className="flex items-center gap-4 min-w-0">
                  <span className={`text-[10px] font-black w-5 opacity-20 group-hover:opacity-100 transition-opacity`}>
                    {(idx + 1).toString().padStart(2, '0')}
                  </span>
                  <span className={`text-sm font-bold truncate ${currentChapter === item.label ? 'text-accent-500' : 'opacity-80'}`}>
                    {item.label}
                  </span>
                </div>
                {currentChapter === item.label && (
                  <div className="w-1.5 h-1.5 rounded-full bg-accent-500 shadow-[0_0_8px_rgba(var(--accent-500-rgb),0.6)]" />
                )}
              </button>
            ))
          )}
        </div>
        
        <div className="p-6">
          <button 
            onClick={onClose} 
            className="w-full py-4 bg-slate-900 text-white font-black rounded-2xl tracking-[0.2em] uppercase text-[10px] shadow-xl active:scale-95 transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
