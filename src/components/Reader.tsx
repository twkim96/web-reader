// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFullFile } from '../lib/googleDrive';
import { SettingsModal } from './SettingsModal';
import { SearchModal } from './SearchModal';
import { ChevronLeft, Settings, Moon, Sun, Hash, X, Check, Search } from 'lucide-react';

interface ReaderProps {
  book: Book;
  googleToken: string;
  initialProgress?: UserProgress;
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (absoluteCharIndex: number, progressPercent: number) => void;
}

export const Reader: React.FC<ReaderProps> = ({ 
  book, googleToken, initialProgress, settings, onUpdateSettings, onBack, onSaveProgress 
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  
  const [showConfirm, setShowConfirm] = useState<{show: boolean, type: 'jump' | 'input', target?: number, fromSearch?: boolean}>({ show: false, type: 'jump' });
  const [jumpInput, setJumpInput] = useState("");

  const [readPercent, setReadPercent] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const fullContent = useRef<string>(""); 
  const rawBuffer = useRef<ArrayBuffer | null>(null);

  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  
  const hasRestored = useRef<string | null>(null);
  const lastSaveTime = useRef<number>(0);
  const isJumping = useRef(false);
  const preSlideProgress = useRef({ percent: 0, index: 0 });
  
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;
  const BLOCK_SIZE = 15000; 
  const MAX_VISIBLE_BLOCKS = 4; 

  const getVisibleBlocks = () => {
    const blocks = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      const start = i * BLOCK_SIZE;
      const end = Math.min(start + BLOCK_SIZE, fullContent.current.length);
      if (start < fullContent.current.length) {
        blocks.push({ index: i, text: fullContent.current.substring(start, end) });
      }
    }
    return blocks;
  };

  const decodeData = useCallback((buffer: ArrayBuffer, mode: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le') => {
    const view = new Uint8Array(buffer);
    const isUTF16LE = view[0] === 0xFF && view[1] === 0xFE;
    const isUTF16BE = view[0] === 0xFE && view[1] === 0xFF;
    if (mode === 'auto') {
      try {
        const decoder = new TextDecoder((isUTF16LE || isUTF16BE) ? (isUTF16LE ? 'utf-16le' : 'utf-16be') : 'utf-8', { fatal: true });
        fullContent.current = decoder.decode(buffer);
      } catch (e) {
        fullContent.current = new TextDecoder('euc-kr').decode(buffer);
      }
    } else {
      fullContent.current = new TextDecoder(mode).decode(buffer);
    }
  }, []);

  const jumpToIdx = useCallback((targetIdx: number) => {
    if (!isLoaded || !fullContent.current) return;
    isJumping.current = true;
    const safeIdx = Math.max(0, Math.min(targetIdx, fullContent.current.length - 1));
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    const internalIdx = safeIdx % BLOCK_SIZE;

    setPaddingTop(0);
    blockHeights.current = {};
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(fullContent.current.length / BLOCK_SIZE)) });

    setTimeout(() => {
      const blockElem = blockRefs.current[blockIdx];
      const textNode = blockElem?.firstChild;
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        try {
          const range = document.createRange();
          const offset = Math.min(internalIdx, textNode.textContent?.length || 0);
          range.setStart(textNode, offset);
          range.setEnd(textNode, offset);
          const rect = range.getBoundingClientRect();
          window.scrollTo({ top: window.scrollY + rect.top - 20, behavior: 'instant' });
        } catch (e) {
          const ratio = internalIdx / BLOCK_SIZE;
          window.scrollTo({ top: (blockElem?.offsetTop || 0) + ((blockElem?.offsetHeight || 0) * ratio), behavior: 'instant' });
        }
      }
      setTimeout(() => { isJumping.current = false; }, 100);
    }, 60);
  }, [isLoaded, BLOCK_SIZE]);

  useEffect(() => {
    const init = async () => {
      try {
        const buffer = await fetchFullFile(book.id, googleToken);
        rawBuffer.current = buffer;
        decodeData(buffer, settings.encoding);
        setIsLoaded(true);
      } catch (err) { console.error(err); }
    };
    init();
  }, [book.id, googleToken, decodeData]);

  useEffect(() => {
    if (!isLoaded || hasRestored.current === book.id) return;
    if (initialProgress && initialProgress.charIndex > 0) {
      setCurrentIdx(initialProgress.charIndex);
      setReadPercent(initialProgress.progressPercent);
      jumpToIdx(initialProgress.charIndex);
      hasRestored.current = book.id;
    } else if (isLoaded) {
      hasRestored.current = book.id;
    }
  }, [isLoaded, initialProgress, book.id, jumpToIdx]);

  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current || !isLoaded || hasRestored.current !== book.id) return;
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;

      if (totalH - (scrolled + vh) < 1500) {
        if ((visibleRange.end + 1) * BLOCK_SIZE < fullContent.current.length) {
          setVisibleRange(prev => {
            const newEnd = prev.end + 1;
            if (newEnd - prev.start + 1 > MAX_VISIBLE_BLOCKS) {
              const startBlock = blockRefs.current[prev.start];
              if (startBlock) {
                const h = startBlock.offsetHeight;
                blockHeights.current[prev.start] = h;
                setPaddingTop(pt => pt + h);
                window.scrollBy(0, -h);
                return { start: prev.start + 1, end: newEnd };
              }
            }
            return { ...prev, end: newEnd };
          });
        }
      }

      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const h = blockHeights.current[newStart] || 0;
          if (h > 0) {
            setPaddingTop(pt => Math.max(0, pt - h));
            window.scrollBy(0, h);
          }
          return { start: newStart, end: (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end };
        });
      }

      const firstVisibleBlock = blockRefs.current[visibleRange.start];
      if (firstVisibleBlock) {
        const blockProgress = Math.max(0, (scrolled - paddingTop) / (firstVisibleBlock.offsetHeight || 1));
        const absoluteIdx = Math.floor((visibleRange.start + blockProgress) * BLOCK_SIZE);
        const totalSize = fullContent.current.length || 1;
        setCurrentIdx(Math.min(absoluteIdx, totalSize));
        setReadPercent((absoluteIdx / totalSize) * 100);
        const now = Date.now();
        if (now - lastSaveTime.current > 5000) {
          onSaveProgress(Math.min(absoluteIdx, totalSize), (absoluteIdx / totalSize) * 100);
          lastSaveTime.current = now;
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isLoaded, visibleRange, paddingTop, onSaveProgress, book.id, BLOCK_SIZE]);

  const handleInteraction = (e: React.MouseEvent) => {
    const { clientY } = e;
    const h = window.innerHeight;
    
    // 현재 설정된 폰트 크기와 줄 간격을 바탕으로 한 줄의 높이를 계산 (약간의 마진 포함)
    const oneLineHeight = settings.fontSize * settings.lineHeight;
    const scrollStep = h - oneLineHeight - 10; 

    if (settings.navMode === 'page') {
      if (clientY > h * 0.65) {
        // 하단 탭: 다음 페이지로 이동하되, 마지막 한 줄만 겹치게 스크롤
        window.scrollBy({ top: scrollStep, behavior: 'instant' });
        return;
      } else if (clientY < h * 0.35) {
        // 상단 탭: 이전 페이지로 이동
        window.scrollBy({ top: -scrollStep, behavior: 'instant' });
        return;
      }
    }
    setShowControls(!showControls);
  };

  const confirmJump = () => {
    if (showConfirm.type === 'jump' && showConfirm.target !== undefined) {
      jumpToIdx(showConfirm.target);
      if (showConfirm.fromSearch) setShowSearch(false);
    } else if (showConfirm.type === 'input') {
      if (jumpInput.includes('%')) {
        const p = parseFloat(jumpInput.replace('%', ''));
        if (!isNaN(p)) jumpToIdx(Math.floor((p / 100) * (fullContent.current.length || 1)));
      } else {
        const idx = parseInt(jumpInput.replace(/,/g, ''));
        if (!isNaN(idx)) jumpToIdx(idx);
      }
    }
    setShowConfirm({ show: false, type: 'jump' });
    setJumpInput("");
  };

  const cancelJump = () => {
    if (!showConfirm.fromSearch && showConfirm.type === 'jump') {
      setReadPercent(preSlideProgress.current.percent);
      setCurrentIdx(preSlideProgress.current.index);
    }
    setShowConfirm({ show: false, type: 'jump' });
    setJumpInput("");
  };

  const getFontClass = () => {
    if (settings.fontFamily === 'ridi') return 'font-["RidiBatang"]';
    if (settings.fontFamily === 'serif') return 'font-serif';
    return 'font-sans';
  };

  if (!isLoaded) return <div className={`h-screen w-screen flex items-center justify-center ${theme.bg} text-xs font-black uppercase opacity-20 tracking-widest`}>Loading...</div>;

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} transition-colors duration-300 ${getFontClass()} select-none`}>
      {showConfirm.show && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
          <div className={`${theme.bg} ${theme.text} w-full max-w-xs rounded-3xl p-6 shadow-2xl border ${theme.border} animate-in zoom-in-95 duration-200`}>
            <p className="text-sm font-bold mb-6 text-center">해당 위치로 이동할까요?</p>
            {showConfirm.type === 'input' && (
              <input autoFocus type="text" value={jumpInput} onChange={(e) => setJumpInput(e.target.value)} placeholder="50% 또는 100000" className="w-full bg-black/5 dark:bg-white/5 border border-white/10 rounded-xl p-3 mb-6 text-center outline-none focus:ring-2 ring-indigo-500" />
            )}
            <div className="flex gap-3">
              <button onClick={cancelJump} className="flex-1 py-3 bg-red-500/10 text-red-500 font-bold rounded-2xl transition-colors">취소</button>
              <button onClick={confirmJump} className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-500/30 transition-transform active:scale-95">이동</button>
            </div>
          </div>
        </div>
      )}

      {showSearch && (
        <SearchModal 
          content={fullContent.current} 
          theme={theme} 
          onClose={() => setShowSearch(false)} 
          onSelect={(idx) => setShowConfirm({ show: true, type: 'jump', target: idx, fromSearch: true })}
        />
      )}

      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={onBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      <main onClick={handleInteraction} className="min-h-screen pt-12 pb-96 relative" style={{ paddingLeft: `${settings.padding}px`, paddingRight: `${settings.padding}px`, textAlign: settings.textAlign }}>
        <div style={{ height: `${paddingTop}px` }} />
        <div className="max-w-3xl mx-auto whitespace-pre-wrap break-words" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>
          {getVisibleBlocks().map(block => (
            <div key={`${book.id}-${block.index}`} ref={el => { blockRefs.current[block.index] = el; }}>{block.text}</div>
          ))}
        </div>
      </main>

      <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
        <div className={`absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-6 py-2.5 rounded-full border border-white/10 shadow-xl flex items-center gap-3 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <span className="text-[10px] font-black text-white tracking-widest font-sans">
            {currentIdx.toLocaleString()} / {(fullContent.current.length || 0).toLocaleString()} 
            <span className="ml-2 text-indigo-400">{readPercent.toFixed(1)}%</span>
          </span>
          <button onClick={() => setShowConfirm({ show: true, type: 'input', fromSearch: false })} className="text-white/50 hover:text-white"><Hash size={14} /></button>
        </div>

        <div className="max-w-lg mx-auto px-6 pt-6 pb-2 flex items-center gap-4">
          <input 
            type="range" min="0" max="100" step="0.1" value={readPercent} 
            onMouseDown={() => { preSlideProgress.current = { percent: readPercent, index: currentIdx }; }}
            onChange={(e) => {
              const p = parseFloat(e.target.value);
              setReadPercent(p);
              setCurrentIdx(Math.floor((p / 100) * (fullContent.current.length || 1)));
            }}
            onMouseUp={() => setShowConfirm({ show: true, type: 'jump', target: currentIdx, fromSearch: false })}
            className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
          <button onClick={() => setShowSearch(true)} className="p-2 -mr-2 opacity-60 hover:opacity-100 transition-opacity">
            <Search size={22} />
          </button>
        </div>

        <div className="flex justify-around p-5 max-w-lg mx-auto font-sans">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button onClick={() => onUpdateSettings({ theme: settings.theme === 'dark' ? 'sepia' : 'dark' })} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            {settings.theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />}<span className="text-[9px] font-bold uppercase tracking-tighter">Mode</span>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal settings={settings} onUpdateSettings={onUpdateSettings} onClose={() => setShowSettings(false)} theme={theme} />}
    </div>
  );
};