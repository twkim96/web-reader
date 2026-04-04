// src/components/SearchModal.tsx
import React, { useState, useEffect } from 'react';
import { Search, X, ArrowRight } from 'lucide-react';

interface SearchResult {
  index: number;
  previewBefore: string;
  match: string;
  previewAfter: string;
}

interface SearchModalProps {
  content: string;
  theme: any;
  onClose: () => void;
  onSelect: (index: number) => void;
}

export const SearchModal: React.FC<SearchModalProps> = ({ content, theme, onClose, onSelect }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    const timer = setTimeout(() => {
      const searchResults: SearchResult[] = [];
      const lowerContent = content.toLowerCase();
      const lowerQuery = query.toLowerCase();
      let pos = 0;

      while (true) {
        pos = lowerContent.indexOf(lowerQuery, pos);
        if (pos === -1 || searchResults.length >= 100) break;

        const start = Math.max(0, pos - 50);
        const end = Math.min(content.length, pos + query.length + 70);

        searchResults.push({
          index: pos,
          previewBefore: content.substring(start, pos).replace(/\s+/g, ' '),
          match: content.substring(pos, pos + query.length),
          previewAfter: content.substring(pos + query.length, end).replace(/\s+/g, ' ')
        });

        pos += lowerQuery.length;
      }
      setResults(searchResults);
    }, 300);

    return () => clearTimeout(timer);
  }, [query, content]);

  return (
    <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[15vh] p-4 animate-in fade-in duration-200" onClick={onClose}>
      <div 
        className={`w-full max-w-2xl ${theme.bg} ${theme.text} rounded-[2rem] shadow-2xl border ${theme.border} overflow-hidden flex flex-col max-h-[75vh] animate-in slide-in-from-top-4 zoom-in-95 duration-300`}
        onClick={e => e.stopPropagation()}
      >
        <div className="relative flex items-center p-2">
          <div className="pl-6 pr-2">
            <Search className="opacity-50" size={28} />
          </div>
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="본문에서 검색어 입력 (2자 이상)..."
            className={`w-full py-6 pr-6 bg-transparent text-xl focus:outline-none font-bold placeholder:opacity-30`}
          />
          {query && (
            <button 
              type="button"
              onClick={() => setQuery('')}
              className="mr-4 p-2 rounded-full opacity-50 hover:bg-black/10 hover:opacity-100 transition-all"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {query.trim().length >= 2 && (
           <div className={`border-t ${theme.border} flex-1 overflow-y-auto`}>
             {results.length > 0 ? (
               <div className="py-2">
                 <div className="px-6 py-2 flex items-center justify-between">
                   <div className="text-[10px] font-black uppercase tracking-widest text-accent-500">Results</div>
                   <div className="text-[10px] font-black uppercase tracking-widest opacity-40">{results.length} found</div>
                 </div>
                 {results.map((res, i) => (
                   <button
                     key={i}
                     onClick={() => { onClose(); onSelect(res.index); }}
                     className="w-full text-left p-6 hover:bg-accent-500/10 transition-colors group flex flex-col gap-2 border-b border-black/5 dark:border-white/5 last:border-none"
                   >
                     <div className="flex items-center justify-between mb-1">
                       <span className="text-[10px] font-black uppercase tracking-widest opacity-30 italic">INDEX: {res.index.toLocaleString()}</span>
                       <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-accent-500" />
                     </div>
                     <p className="text-sm leading-relaxed line-clamp-2 break-all group-hover:text-accent-500 transition-colors">
                       <span className="opacity-50 group-hover:opacity-100">{res.previewBefore}</span>
                       <span className="text-accent-600 dark:text-accent-400 font-bold bg-accent-500/10 px-0.5 mx-0.5 rounded-sm">{res.match}</span>
                       <span className="opacity-50 group-hover:opacity-100">{res.previewAfter}</span>
                     </p>
                   </button>
                 ))}
               </div>
             ) : (
                <div className="py-16 text-center opacity-50 font-bold text-sm">
                  검색 결과가 없습니다.
                </div>
             )}
           </div>
        )}
      </div>
    </div>
  );
};