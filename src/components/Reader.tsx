// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFullFile } from '../lib/googleDrive';
import { SettingsModal } from './SettingsModal';
import { ChevronLeft, Settings, Moon, Sun, Hash } from 'lucide-react';

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

  // 슬라이더 조작 시 복구를 위한 백업 값
  const preSlideProgress = useRef({ percent: 0, index: 0 });
  
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;
  const BLOCK_SIZE = 30000;
  const MAX_VISIBLE_BLOCKS = 3;

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
        if (isUTF16LE || isUTF16BE) {
          const decoder = new TextDecoder(isUTF16LE ? 'utf-16le' : 'utf-16be');
          fullContent.current = decoder.decode(buffer);
        } else {
          const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
          fullContent.current = utf8Decoder.decode(buffer);
        }
      } catch (e) {
        const eucKrDecoder = new TextDecoder('euc-kr');
        fullContent.current = eucKrDecoder.decode(buffer);
      }
    } else {
      const decoder = new TextDecoder(mode);
      fullContent.current = decoder.decode(buffer);
    }
  }, []);

  const jumpToIdx = useCallback((targetIdx: number) => {
    if (!isLoaded) return;
    isJumping.current = true;
    const safeIdx = Math.max(0, Math.min(targetIdx, fullContent.current.length - 1));
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    
    setPaddingTop(0);
    blockHeights.current = {};
    setVisibleRange({ start: blockIdx, end: blockIdx });
    
    setTimeout(() => {
      const blockElem = blockRefs.current[blockIdx];
      if (blockElem) {
        const ratio = (safeIdx % BLOCK_SIZE) / (BLOCK_SIZE || 1);
        const targetScroll = blockElem.offsetTop + (blockElem.offsetHeight * ratio);
        window.scrollTo({ top: targetScroll, behavior: 'instant' });
      }
      isJumping.current = false;
    }, 100);
  }, [isLoaded]);

  useEffect(() => {
    const init = async () => {
      try {
        const buffer = await fetchFullFile(book.id, googleToken);
        rawBuffer.current = buffer;
        decodeData(buffer, settings.encoding);
        
        const startBlock = initialProgress ? Math.floor(initialProgress.charIndex / BLOCK_SIZE) : 0;
        setVisibleRange({ start: startBlock, end: startBlock });
        setCurrentIdx(initialProgress?.charIndex || 0);
        setReadPercent(initialProgress?.progressPercent || 0);
        setIsLoaded(true);
      } catch (err) { console.error(err); }
    };
    init();
  }, [book.id, googleToken, decodeData]);

  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current) return;
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;
      if (!isLoaded || hasRestored.current !== book.id) return;

      if (totalH - (scrolled + vh) < 2000) {
        if ((visibleRange.end + 1) * BLOCK_SIZE < fullContent.current.length) {
          setVisibleRange(prev => ({ ...prev, end: prev.end + 1 }));
        }
      }

      if (visibleRange.end - visibleRange.start >= MAX_VISIBLE_BLOCKS && scrolled > totalH * 0.6) {
        const firstBlockIdx = visibleRange.start;
        const firstBlockElem = blockRefs.current[firstBlockIdx];
        if (firstBlockElem) {
          const height = firstBlockElem.offsetHeight;
          blockHeights.current[firstBlockIdx] = height;
          setPaddingTop(prev => prev + height);
          setVisibleRange(prev => ({ ...prev, start: prev.start + 1 }));
          window.scrollBy(0, -height);
        }
      }

      if (scrolled < 1500 && visibleRange.start > 0) {
        const prevBlockIdx = visibleRange.start - 1;
        const prevHeight = blockHeights.current[prevBlockIdx] || 0;
        setVisibleRange(prev => ({ ...prev, start: prev.start - 1 }));
        if (prevHeight > 0) {
          setPaddingTop(prev => Math.max(0, prev - prevHeight));
          window.scrollBy(0, prevHeight);
        }
        if (visibleRange.end - visibleRange.start >= MAX_VISIBLE_BLOCKS) {
          setVisibleRange(prev => ({ ...prev, end: prev.end - 1 }));
        }
      }

      const firstVisibleBlock = blockRefs.current[visibleRange.start];
      if (firstVisibleBlock) {
        const blockProgress = Math.max(0, (scrolled - paddingTop) / (firstVisibleBlock.offsetHeight || 1));
        const absoluteIdx = Math.floor((visibleRange.start + blockProgress) * BLOCK_SIZE);
        const totalSize = fullContent.current.length || 1;
        const finalPercent = (absoluteIdx / totalSize) * 100;
        
        setCurrentIdx(Math.min(absoluteIdx, totalSize));
        setReadPercent(finalPercent);

        const now = Date.now();
        if (now - lastSaveTime.current > 3000) {
          onSaveProgress(Math.min(absoluteIdx, totalSize), finalPercent);
          lastSaveTime.current = now;
        }
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isLoaded, visibleRange, paddingTop, onSaveProgress, book.id]);

  const handleInteraction = (e: React.MouseEvent) => {
    const { clientY } = e;
    const h = window.innerHeight;
    if (settings.navMode === 'page') {
      if (clientY < h * 0.3) { window.scrollBy({ top: -(h - 60), behavior: 'instant' }); return; }
      else if (clientY > h * 0.7) { window.scrollBy({ top: (h - 60), behavior: 'instant' }); return; }
    }
    setShowControls(!showControls);
  };

  // 슬라이더 터치/클릭 시작 시 현재 위치 백업
  const handleSliderStart = () => {
    preSlideProgress.current = { percent: readPercent, index: currentIdx };
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const percent = parseFloat(e.target.value);
    const targetIdx = Math.floor((percent / 100) * fullContent.current.length);
    setReadPercent(percent);
    setCurrentIdx(targetIdx);
  };

  // 슬라이더에서 손을 뗄 때 확인창 표시
  const handleSliderRelease = () => {
    if (window.confirm(`${readPercent.toFixed(1)}% 위치로 이동하시겠습니까?`)) {
      jumpToIdx(currentIdx);
    } else {
      // 취소 시 이전 위치로 복구
      setReadPercent(preSlideProgress.current.percent);
      setCurrentIdx(preSlideProgress.current.index);
    }
  };

  const promptJump = () => {
    const input = window.prompt(`이동할 위치를 입력하세요.\n(예: 50% 또는 100000)`, currentIdx.toString());
    if (input) {
      if (input.includes('%')) {
        const p = parseFloat(input.replace('%', ''));
        if (!isNaN(p)) jumpToIdx(Math.floor((p / 100) * fullContent.current.length));
      } else {
        const idx = parseInt(input.replace(/,/g, ''));
        if (!isNaN(idx)) jumpToIdx(idx);
      }
    }
  };

  const getFontClass = () => {
    if (settings.fontFamily === 'ridi') return 'font-["RidiBatang"]';
    if (settings.fontFamily === 'serif') return 'font-serif';
    return 'font-sans';
  };

  if (!isLoaded) return <div className={`h-screen w-screen flex items-center justify-center ${theme.bg}`}>...</div>;

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} transition-colors duration-300 ${getFontClass()} select-none`}>
      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={onBack} className="p-2 rounded-full hover:bg-black/5 transition-colors">
          <ChevronLeft />
        </button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      <main onClick={handleInteraction} className="min-h-screen pt-12 pb-96 relative" style={{ paddingLeft: `${settings.padding}px`, paddingRight: `${settings.padding}px`, textAlign: settings.textAlign }}>
        <div style={{ height: `${paddingTop}px` }} />
        <div className="max-w-3xl mx-auto whitespace-pre-wrap break-words" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>
          {getVisibleBlocks().map(block => (
            <div key={`${book.id}-${block.index}`} ref={el => { blockRefs.current[block.index] = el; }}>
              {block.text}
            </div>
          ))}
        </div>
      </main>

      <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
        <div className={`absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-6 py-2.5 rounded-full border border-white/10 shadow-xl whitespace-nowrap transition-opacity duration-300 flex items-center gap-3 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <span className="text-[10px] font-black text-white tracking-widest font-sans">
            ({currentIdx.toLocaleString()} / {fullContent.current.length.toLocaleString()}) 
            <span className="ml-2 text-indigo-400">{readPercent.toFixed(1)}%</span>
          </span>
          <button onClick={promptJump} className="text-white/50 hover:text-white transition-colors">
            <Hash size={14} />
          </button>
        </div>

        <div className="max-w-lg mx-auto px-6 pt-6 pb-2">
          <input 
            type="range" 
            min="0" 
            max="100" 
            step="0.1" 
            value={readPercent} 
            onMouseDown={handleSliderStart}
            onTouchStart={handleSliderStart}
            onChange={handleSliderChange}
            onMouseUp={handleSliderRelease}
            onTouchEnd={handleSliderRelease}
            className="w-full h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
          />
        </div>

        <div className="flex justify-around p-5 max-w-lg mx-auto font-sans">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button 
            onClick={() => onUpdateSettings({ theme: settings.theme === 'dark' ? 'sepia' : 'dark' })} 
            className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity"
          >
            {settings.theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />}
            <span className="text-[9px] font-bold uppercase tracking-tighter">Mode</span>
          </button>
        </div>
      </div>

      {showSettings && (
        <SettingsModal 
          settings={settings} 
          onUpdateSettings={onUpdateSettings} 
          onClose={() => setShowSettings(false)} 
          theme={theme} 
        />
      )}
    </div>
  );
};