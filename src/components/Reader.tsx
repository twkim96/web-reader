// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFullFile } from '../lib/googleDrive';
import { SettingsModal } from './SettingsModal'; // 분리된 모달 임포트
import { ChevronLeft, Settings, Moon, Sun } from 'lucide-react';

interface ReaderProps {
  book: Book;
  googleToken: string;
  initialProgress?: UserProgress;
  settings: ViewerSettings;
  // [수정] 프롭 이름을 onUpdateSettings로 변경하고 Partial 타입을 적용합니다.
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
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  
  const fullContent = useRef<string>(""); 
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const hasRestored = useRef<string | null>(null);
  const lastSaveTime = useRef<number>(0);
  
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

  const getFontClass = () => {
    if (settings.fontFamily === 'ridi') return 'font-["RidiBatang"]';
    if (settings.fontFamily === 'serif') return 'font-serif';
    return 'font-sans';
  };

  useEffect(() => {
    const init = async () => {
      try {
        const result = await fetchFullFile(book.id, googleToken);
        fullContent.current = result.text;
        const startBlock = initialProgress ? Math.floor(initialProgress.charIndex / BLOCK_SIZE) : 0;
        setVisibleRange({ start: startBlock, end: startBlock });
        setCurrentIdx(initialProgress?.charIndex || 0);
        setReadPercent(initialProgress?.progressPercent || 0);
        setIsLoaded(true);
      } catch (err) { console.error(err); }
    };
    init();
  }, [book.id, googleToken]);

  useEffect(() => {
    if (isLoaded && hasRestored.current !== book.id) {
      const timer = setTimeout(() => {
        if (initialProgress) {
          const blockIdx = Math.floor(initialProgress.charIndex / BLOCK_SIZE);
          const blockElem = blockRefs.current[blockIdx];
          if (blockElem) {
            const ratio = (initialProgress.charIndex % BLOCK_SIZE) / BLOCK_SIZE;
            window.scrollTo({ top: blockElem.offsetTop + (blockElem.offsetHeight * ratio), behavior: 'instant' });
          }
        }
        hasRestored.current = book.id;
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isLoaded, book.id, initialProgress]);

  useEffect(() => {
    const handleScroll = () => {
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
      if (clientY < h * 0.3) { window.scrollBy({ top: -(h - 60), behavior: 'smooth' }); return; }
      else if (clientY > h * 0.7) { window.scrollBy({ top: (h - 60), behavior: 'smooth' }); return; }
    }
    setShowControls(!showControls);
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
        <div className={`absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-6 py-2.5 rounded-full border border-white/10 shadow-xl whitespace-nowrap transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <span className="text-[10px] font-black text-white tracking-widest font-sans">
            ({currentIdx.toLocaleString()} / {fullContent.current.length.toLocaleString()}) 
            <span className="ml-2 text-indigo-400">{readPercent.toFixed(1)}%</span>
          </span>
        </div>

        <div className="flex justify-around p-5 max-w-lg mx-auto font-sans">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button onClick={() => onUpdateSettings({ theme: settings.theme === 'dark' ? 'sepia' : 'dark' })} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
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