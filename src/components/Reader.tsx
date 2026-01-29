// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFullFile } from '../lib/googleDrive';
import { SettingsModal } from './SettingsModal';
import { ChevronLeft, Settings, Moon, Sun } from 'lucide-react';

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
  
  // 진행도 및 텍스트 상태
  const [readPercent, setReadPercent] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const fullContent = useRef<string>(""); 
  const rawBuffer = useRef<ArrayBuffer | null>(null);

  // 가상화 상태
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
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

  /**
   * [핵심] 인코딩 감지 및 디코딩 함수
   */
  const decodeData = useCallback((buffer: ArrayBuffer, mode: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le') => {
    const view = new Uint8Array(buffer);
    const isUTF16LE = view[0] === 0xFF && view[1] === 0xFE;
    const isUTF16BE = view[0] === 0xFE && view[1] === 0xFF;

    if (mode === 'auto') {
      try {
        if (isUTF16LE || isUTF16BE) {
          const decoder = new TextDecoder(isUTF16LE ? 'utf-16le' : 'utf-16be');
          fullContent.current = decoder.decode(buffer);
          console.log("자동 감지: UTF-16");
        } else {
          // UTF-8 시도
          const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
          fullContent.current = utf8Decoder.decode(buffer);
          console.log("자동 감지: UTF-8");
        }
      } catch (e) {
        // UTF-8 실패 시 한국어 표준(EUC-KR) 시도
        const eucKrDecoder = new TextDecoder('euc-kr');
        fullContent.current = eucKrDecoder.decode(buffer);
        console.log("자동 감지: EUC-KR");
      }
    } else {
      const decoder = new TextDecoder(mode);
      fullContent.current = decoder.decode(buffer);
    }
  }, []);

  // 1. 초기 데이터 로드 (바이너리)
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

  // 2. 인코딩 변경 시 재디코딩
  useEffect(() => {
    if (rawBuffer.current && isLoaded) {
      decodeData(rawBuffer.current, settings.encoding);
      blockHeights.current = {}; // 텍스트 변경으로 인한 높이 초기화
    }
  }, [settings.encoding, isLoaded, decodeData]);

  // 3. 위치 복구
  useEffect(() => {
    if (isLoaded && hasRestored.current !== book.id) {
      const timer = setTimeout(() => {
        if (initialProgress) {
          const blockIdx = Math.floor(initialProgress.charIndex / BLOCK_SIZE);
          const blockElem = blockRefs.current[blockIdx];
          if (blockElem) {
            const ratio = (initialProgress.charIndex % BLOCK_SIZE) / (BLOCK_SIZE || 1);
            window.scrollTo({ top: blockElem.offsetTop + (blockElem.offsetHeight * ratio), behavior: 'instant' });
          }
        }
        hasRestored.current = book.id;
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [isLoaded, book.id, initialProgress]);

  // 4. 가상화 및 스크롤 핸들러
  useEffect(() => {
    const handleScroll = () => {
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;
      if (!isLoaded || hasRestored.current !== book.id) return;

      // 하단 추가 로드
      if (totalH - (scrolled + vh) < 2000) {
        if ((visibleRange.end + 1) * BLOCK_SIZE < fullContent.current.length) {
          setVisibleRange(prev => ({ ...prev, end: prev.end + 1 }));
        }
      }

      // 상단 제거 (Scroll Down)
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

      // 상단 복구 (Scroll Up)
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

      // 진행도 계산
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
        
        {/* 중앙 클릭 시에만 나타나는 상세 진행도 */}
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