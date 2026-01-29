// src/components/SearchModal.tsx
import React, { useState, useEffect } from 'react';
import { Search, ChevronLeft, ArrowRight } from 'lucide-react';

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

      // 성능을 위해 최대 100개까지만 검색
      while (true) {
        pos = lowerContent.indexOf(lowerQuery, pos);
        if (pos === -1 || searchResults.length >= 100) break;

        // 매치 지점 앞뒤로 약 50자씩 추출하여 미리보기 생성
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
    <div className={`fixed inset-0 z-[110] ${theme.bg} flex flex-col animate-in slide-in-from-bottom duration-300`}>
      {/* 상단 검색바: 아이콘과 입력창 */}
      <header className={`h-16 flex items-center px-4 border-b ${theme.border} shrink-0`}>
        <button onClick={onClose} className="p-2 -ml-2 opacity-60 hover:opacity-100 transition-opacity">
          <ChevronLeft size={24} />
        </button>
        <div className="flex-1 flex items-center gap-3 bg-black/5 dark:bg-white/5 rounded-2xl px-4 py-2.5 ml-2 border border-white/5">
          <Search size={18} className="opacity-40" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색어를 입력하세요 (2자 이상)"
            className="bg-transparent flex-1 outline-none text-sm font-sans"
          />
        </div>
      </header>

      {/* 결과 리스트: 2줄 미리보기 및 하이라이트 */}
      <main className="flex-1 overflow-y-auto font-sans pb-20">
        {query.trim().length >= 2 && results.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center opacity-30 text-sm gap-2">
            <Search size={40} strokeWidth={1} />
            <p>검색 결과가 없습니다.</p>
          </div>
        ) : (
          <div className="divide-y divide-black/5 dark:divide-white/5">
            {results.map((res, i) => (
              <button
                key={i}
                onClick={() => onSelect(res.index)}
                className="w-full text-left p-5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors group flex flex-col gap-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-widest opacity-30 italic">INDEX: {res.index.toLocaleString()}</span>
                  <ArrowRight size={14} className="opacity-0 group-hover:opacity-100 transition-opacity text-indigo-500" />
                </div>
                <p className="text-sm leading-relaxed line-clamp-2 break-all">
                  <span className="opacity-50">{res.previewBefore}</span>
                  <span className="text-indigo-500 font-bold bg-indigo-500/10 px-0.5 rounded-sm">{res.match}</span>
                  <span className="opacity-50">{res.previewAfter}</span>
                </p>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};