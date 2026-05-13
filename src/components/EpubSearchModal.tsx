// src/components/EpubSearchModal.tsx
import React, { useState, useEffect } from 'react';
import { Search, X, ArrowRight, Loader2 } from 'lucide-react';
import { SearchResultPayload } from '../hooks/foliate/types';
import { ThemeClasses } from '../types';

interface EpubSearchModalProps {
  theme: ThemeClasses;
  onClose: () => void;
  onSelect: (cfi: string, progressPercent?: number) => void;
  onSearch: (query: string, onResult: (res: SearchResultPayload) => void, onProgress: (p: number) => void) => Promise<void>;
  onClear: () => void;
}

export const EpubSearchModal: React.FC<EpubSearchModalProps> = ({ theme, onClose, onSelect, onSearch, onClear }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultPayload[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      onClear();
      return;
    }

    const timer = setTimeout(async () => {
      setResults([]);
      setIsSearching(true);
      setProgress(0);
      onClear();
      
      await onSearch(
        query, 
        (res) => setResults(prev => [...prev, res]),
        (p) => setProgress(p)
      );
      
      setIsSearching(false);
    }, 500);

    return () => clearTimeout(timer);
  }, [query, onSearch, onClear]);



  return (
    <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[10vh] p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className={`w-full max-w-2xl ${theme.bg} ${theme.text} rounded-[2rem] shadow-2xl border ${theme.border} overflow-hidden flex flex-col max-h-[80vh] animate-in slide-in-from-top-4 zoom-in-95 duration-300`}
        onClick={e => e.stopPropagation()}
      >
        <div className="relative flex items-center p-2">
          <div className="pl-6 pr-2">
            {isSearching ? <Loader2 className="animate-spin text-accent-500" size={28} /> : <Search className="opacity-50" size={28} />}
          </div>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="본문에서 검색어 입력..."
            className={`w-full py-6 pr-6 bg-transparent text-xl focus:outline-none font-bold placeholder:opacity-30`}
          />
          {query && (
            <button 
              type="button"
              onClick={() => { setQuery(''); setResults([]); onClear(); }}
              className="mr-4 p-2 rounded-full opacity-50 hover:bg-black/10 hover:opacity-100 transition-all"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {isSearching && (
          <div className="h-1 w-full bg-black/10 dark:bg-white/10">
            <div 
              className="h-full bg-accent-500 transition-all duration-300" 
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}

        {query.trim().length >= 2 && (
           <div className={`border-t ${theme.border} flex-1 overflow-y-auto`}>
             {results.length > 0 ? (
               <div className="py-2">
                 <div className="px-6 py-2 flex items-center justify-between">
                   <div className="text-[10px] font-black uppercase tracking-widest text-accent-500">Search Results</div>
                   <div className="text-[10px] font-black uppercase tracking-widest opacity-40">
                     {results.reduce((acc, r) => acc + r.subitems.length, 0)} found
                   </div>
                 </div>
                 {results.map((section, si) => (
                   <div key={si}>
                     {section.label && (
                       <div className="px-6 py-2 bg-black/5 dark:bg-white/5 text-[10px] font-bold opacity-40 uppercase tracking-tighter sticky top-0 z-10 backdrop-blur-md border-y border-black/5 dark:border-white/5">
                         {section.label}
                       </div>
                     )}
                     {section.subitems.map((res, i) => (
                       <button
                         key={`${si}-${i}`}
                         onClick={() => { onClose(); onSelect(res.cfi, section.progress * 100); }}
                         className="w-full text-left px-6 py-4 hover:bg-accent-500/10 transition-colors group flex flex-col gap-1.5 border-b border-black/5 dark:border-white/5 last:border-none"
                       >
                         <div className="flex items-center justify-between">
                           <div className="flex items-center gap-2">
                             <span className="text-[9px] font-bold uppercase tracking-widest opacity-20 group-hover:opacity-40 transition-opacity">MATCH {i + 1}</span>
                             <span className="text-[9px] font-bold text-accent-500/40 group-hover:text-accent-500/60 transition-colors">{(section.progress * 100).toFixed(1)}%</span>
                           </div>
                           <ArrowRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity text-accent-500" />
                         </div>
                         <p className="text-sm leading-snug group-hover:text-accent-500 transition-colors break-words">
                            {typeof res.excerpt === 'string' ? (
                              res.excerpt
                            ) : (
                              <>
                                <span className="opacity-60">{res.excerpt.pre}</span>
                                <span className="font-bold text-accent-600 dark:text-accent-400 bg-accent-500/10 px-0.5 rounded mx-0.5">{res.excerpt.match}</span>
                                <span className="opacity-60">{res.excerpt.post}</span>
                              </>
                            )}
                         </p>
                       </button>
                     ))}
                   </div>
                 ))}
               </div>
             ) : !isSearching && (
                <div className="py-16 text-center opacity-50 font-bold text-sm">
                  검색 결과가 없습니다.
                </div>
             )}
             {isSearching && results.length === 0 && (
                <div className="py-16 text-center opacity-50 font-bold text-sm flex flex-col items-center gap-4">
                  <Loader2 className="animate-spin text-accent-500" size={32} />
                  검색 중... ({(progress * 100).toFixed(0)}%)
                </div>
             )}
           </div>
        )}
      </div>
    </div>
  );
};
