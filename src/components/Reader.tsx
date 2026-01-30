// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings, Bookmark } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFullFile } from '../lib/googleDrive';
import { saveOfflineBook, getOfflineBook } from '../lib/localDB';
import { SettingsModal } from './SettingsModal';
import { SearchModal } from './SearchModal';
import { BookmarkModal } from './BookmarkModal';
import { ThemeModal } from './ThemeModal'; 
import { ChevronLeft, Settings, Palette, Hash, Search, ArrowUpCircle, Bookmark as BookmarkIcon } from 'lucide-react';

interface ReaderProps {
  book: Book;
  googleToken: string;
  initialProgress?: UserProgress;
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (idx: number, pct: number, bookmarks?: Bookmark[]) => void;
}

export const Reader: React.FC<ReaderProps> = ({ 
  book, googleToken, initialProgress, settings, onUpdateSettings, onBack, onSaveProgress 
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  
  const [showConfirm, setShowConfirm] = useState<{
    show: boolean, 
    type: 'jump' | 'input', 
    target?: number, 
    fromSearch?: boolean,
    originIdx?: number 
  }>({ show: false, type: 'jump' });
  
  const [jumpInput, setJumpInput] = useState("");
  const [syncConflict, setSyncConflict] = useState<{ show: boolean, remoteIdx: number, remotePercent: number } | null>(null);

  const [readPercent, setReadPercent] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(initialProgress?.bookmarks || []);

  const fullContent = useRef<string>(""); 
  const rawBuffer = useRef<ArrayBuffer | null>(null);

  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  
  const hasRestored = useRef<string | null>(null);
  const lastSaveTime = useRef<number>(Date.now());
  const isJumping = useRef(false);
  
  const [pendingJump, setPendingJump] = useState<{ blockIdx: number, internalOffset: number } | null>(null);
  const preSlideProgress = useRef({ percent: 0, index: 0 });
  
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;
  const BLOCK_SIZE = 15000; 
  const MAX_VISIBLE_BLOCKS = 4;
  const MANUAL_COLORS = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-blue-500'];

  useEffect(() => {
    window.history.pushState({ panel: 'reader' }, '', '');
    const handlePopState = () => { onBack(); };
    window.addEventListener('popstate', handlePopState);
    return () => { window.removeEventListener('popstate', handlePopState); };
  }, [onBack]);

  const handleUIBack = () => { window.history.back(); };

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

  const getPreviewText = (idx: number) => {
    if (!fullContent.current) return "";
    const start = Math.max(0, idx - 30);
    const end = Math.min(fullContent.current.length, idx + 100);
    return fullContent.current.substring(start, end).replace(/\n/g, ' ').trim();
  };

  // [Modified] DB 저장을 제거하고, 업데이트된 책갈피 리스트를 반환만 하도록 변경
  const createAutoBookmark = (originIndex: number): Bookmark[] => {
    if (originIndex < 100) return bookmarks; 

    const newAutoMark: Bookmark = {
      id: 'auto-bookmark',
      type: 'auto',
      name: getPreviewText(originIndex),
      charIndex: originIndex,
      createdAt: Date.now(),
      color: 'bg-slate-500'
    };

    const filtered = bookmarks.filter(b => b.type !== 'auto');
    return [newAutoMark, ...filtered];
  };

  // [Modified] 수동 추가는 여전히 즉시 저장 (이동이 없으므로 안전)
  const addManualBookmark = () => {
    const manualCount = bookmarks.filter(b => b.type === 'manual').length;
    if (manualCount >= 5) {
      alert("수동 책갈피는 최대 5개까지만 저장할 수 있습니다.");
      return;
    }

    const targetIdx = currentIdx; 
    const usedColors = bookmarks.filter(b => b.type === 'manual').map(b => b.color);
    const nextColor = MANUAL_COLORS.find(c => !usedColors.includes(c)) || MANUAL_COLORS[0];

    const newMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'manual',
      name: getPreviewText(targetIdx),
      charIndex: targetIdx,
      createdAt: Date.now(),
      color: nextColor
    };

    setBookmarks(prev => {
      const updated = [newMark, ...prev];
      onSaveProgress(currentIdx, readPercent, updated);
      lastSaveTime.current = Date.now();
      return updated;
    });
  };

  const deleteBookmark = (id: string) => {
    setBookmarks(prev => {
      const updated = prev.filter(b => b.id !== id);
      onSaveProgress(currentIdx, readPercent, updated);
      lastSaveTime.current = Date.now();
      return updated;
    });
  };

  // [Modified] updatedBookmarks 매개변수 추가 (점프 시 최신 책갈피 반영)
  const jumpToIdx = useCallback((targetIdx: number, updatedBookmarks?: Bookmark[]) => {
    if (!isLoaded || !fullContent.current) return;
    
    const totalLen = fullContent.current.length || 1;
    const safeIdx = Math.max(0, Math.min(targetIdx, totalLen - 1));
    const newPercent = (safeIdx / totalLen) * 100;

    // 1. 상태 즉시 업데이트
    setCurrentIdx(safeIdx);
    setReadPercent(newPercent);
    
    // 2. [Core Fix] 단일 진실 공급원(Single Source of Truth)으로서 저장 수행
    // 자동 책갈피가 생성되었다면 updatedBookmarks를 사용하고, 아니면 기존 bookmarks 사용
    const bookmarksToSave = updatedBookmarks || bookmarks;
    onSaveProgress(safeIdx, newPercent, bookmarksToSave);
    lastSaveTime.current = Date.now();

    // 3. 가상화 및 스크롤 처리
    isJumping.current = true;
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    const internalOffset = safeIdx % BLOCK_SIZE;

    setPaddingTop(0);
    blockHeights.current = {};
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(totalLen / BLOCK_SIZE)) });

    setPendingJump({ blockIdx, internalOffset });
  }, [isLoaded, BLOCK_SIZE, bookmarks, onSaveProgress]);

  useEffect(() => {
    if (pendingJump) {
      const { blockIdx, internalOffset } = pendingJump;
      const blockElem = blockRefs.current[blockIdx];

      if (blockElem && blockElem.firstChild) {
        const textNode = blockElem.firstChild;
        try {
          if (textNode.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            const offset = Math.min(internalOffset, textNode.textContent?.length || 0);
            range.setStart(textNode, offset);
            range.setEnd(textNode, offset);
            const rect = range.getBoundingClientRect();
            window.scrollTo({ top: window.scrollY + rect.top - 20, behavior: 'instant' });
          } else {
             window.scrollTo({ top: blockElem.offsetTop, behavior: 'instant' });
          }
        } catch (e) {
          console.error("Jump Error", e);
        }
        setPendingJump(null);
        setTimeout(() => { isJumping.current = false; }, 100);
      }
    }
  }, [pendingJump, visibleRange]);

  useEffect(() => {
    const init = async () => {
      try {
        let buffer: ArrayBuffer;
        const offlineData = await getOfflineBook(book.id);
        if (offlineData) {
          buffer = offlineData.data;
        } else {
          buffer = await fetchFullFile(book.id, googleToken);
          saveOfflineBook(book.id, book.name, buffer).catch(console.error);
        }
        rawBuffer.current = buffer;
        decodeData(buffer, settings.encoding);
        setIsLoaded(true);
      } catch (err) { 
        console.error(err); 
        alert("파일을 불러오는데 실패했습니다.");
        onBack();
      }
    };
    init();
  }, [book.id, googleToken, decodeData]); 

  useEffect(() => {
    if (!isLoaded || hasRestored.current === book.id) return;
    if (initialProgress) {
      if (initialProgress.charIndex > 0) {
        setCurrentIdx(initialProgress.charIndex);
        setReadPercent(initialProgress.progressPercent);
        jumpToIdx(initialProgress.charIndex);
      }
      if (initialProgress.bookmarks) {
        setBookmarks(initialProgress.bookmarks);
      }
      hasRestored.current = book.id;
    } else if (isLoaded) {
      hasRestored.current = book.id;
    }
  }, [isLoaded, initialProgress, book.id, jumpToIdx]);

  useEffect(() => {
    if (!isLoaded || !initialProgress || !initialProgress.lastRead) return;
    const remoteTime = initialProgress.lastRead.toMillis ? initialProgress.lastRead.toMillis() : new Date(initialProgress.lastRead).getTime();
    
    if (remoteTime > lastSaveTime.current + 2000) {
      if (Math.abs(initialProgress.charIndex - currentIdx) > 300) {
        setSyncConflict({
          show: true,
          remoteIdx: initialProgress.charIndex,
          remotePercent: initialProgress.progressPercent
        });
      }
      if (initialProgress.bookmarks) {
        setBookmarks(initialProgress.bookmarks);
      }
    }
  }, [initialProgress, currentIdx, isLoaded]);

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
        if (now - lastSaveTime.current > 5000 && !syncConflict) {
          onSaveProgress(Math.min(absoluteIdx, totalSize), (absoluteIdx / totalSize) * 100, bookmarks);
          lastSaveTime.current = now;
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isLoaded, visibleRange, paddingTop, onSaveProgress, book.id, BLOCK_SIZE, syncConflict, bookmarks]);

  const handleInteraction = (e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const oneLineHeight = settings.fontSize * settings.lineHeight;
    const linesPerScreen = Math.floor(h / oneLineHeight);
    const scrollStep = linesPerScreen * oneLineHeight; 
    const move = (dir: number) => { window.scrollBy({ top: dir * scrollStep, behavior: 'instant' }); };

    if (settings.navMode !== 'scroll') {
      if (settings.navMode === 'page') {
        if (clientY > h * 0.7) { move(1); return; }
        if (clientY < h * 0.3) { move(-1); return; }
      }
      else if (settings.navMode === 'left-right') {
        if (clientX < w * 0.3) { move(-1); return; }
        if (clientX > w * 0.7) { move(1); return; }
      }
      else if (settings.navMode === 'all-dir') {
        if (clientY < h * 0.3) { move(-1); return; }
        if (clientY > h * 0.7) { move(1); return; }
        if (clientX < w * 0.3) { move(-1); return; }
        if (clientX > w * 0.7) { move(1); return; }
      }
    }
    setShowControls(!showControls);
  };

  const confirmJump = () => {
    let updatedBookmarks = undefined;

    // 1. 자동 책갈피 생성 (state 업데이트 + 로컬 변수에 저장)
    if (showConfirm.originIdx !== undefined) {
      updatedBookmarks = createAutoBookmark(showConfirm.originIdx);
      setBookmarks(updatedBookmarks);
    }

    // 2. 점프 수행 (업데이트된 책갈피 전달)
    if (showConfirm.type === 'jump' && showConfirm.target !== undefined) {
      jumpToIdx(showConfirm.target, updatedBookmarks);
      if (showConfirm.fromSearch) setShowSearch(false);
    } else if (showConfirm.type === 'input') {
      if (jumpInput.includes('%')) {
        const p = parseFloat(jumpInput.replace('%', ''));
        if (!isNaN(p)) {
            const idx = Math.floor((p / 100) * (fullContent.current.length || 1));
            jumpToIdx(idx, updatedBookmarks);
        }
      } else {
        const idx = parseInt(jumpInput.replace(/,/g, ''));
        if (!isNaN(idx)) jumpToIdx(idx, updatedBookmarks);
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

  const handleSyncResolve = (action: 'sync' | 'ignore') => {
    if (action === 'sync' && syncConflict) {
      const updatedBookmarks = createAutoBookmark(currentIdx);
      setBookmarks(updatedBookmarks);
      
      jumpToIdx(syncConflict.remoteIdx, updatedBookmarks);
    } else {
      lastSaveTime.current = Date.now();
    }
    setSyncConflict(null);
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

      {syncConflict && (
         <div className="fixed z-[100] max-w-sm w-[90%] md:w-full animate-in duration-500 bottom-24 left-1/2 -translate-x-1/2 md:top-auto md:left-auto md:bottom-24 md:right-6 md:translate-x-0 zoom-in-95 md:zoom-in-100 md:slide-in-from-right">
          <div className="bg-slate-900/90 text-white backdrop-blur-md p-4 rounded-3xl shadow-2xl border border-white/10 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-indigo-500/20 rounded-full text-indigo-400"><ArrowUpCircle size={20} /></div>
              <div className="flex-1">
                <h4 className="text-sm font-bold">원격 기록 발견</h4>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">다른 기기에서 <span className="text-indigo-400 font-bold">{syncConflict.remotePercent.toFixed(1)}%</span>까지 읽은 기록이 있습니다. 동기화하시겠습니까?</p>
              </div>
            </div>
            <div className="flex gap-2 pl-11">
              <button onClick={() => handleSyncResolve('ignore')} className="flex-1 py-2 text-xs font-bold text-slate-400 hover:bg-white/5 rounded-xl transition-colors">무시하기</button>
              <button onClick={() => handleSyncResolve('sync')} className="flex-1 py-2 text-xs font-bold bg-indigo-600 hover:bg-indigo-500 rounded-xl shadow-lg shadow-indigo-500/20 transition-colors">동기화 (이동)</button>
            </div>
          </div>
        </div>
      )}

      {showSearch && (
        <SearchModal 
          content={fullContent.current} 
          theme={theme} 
          onClose={() => setShowSearch(false)} 
          onSelect={(idx) => setShowConfirm({ show: true, type: 'jump', target: idx, fromSearch: true, originIdx: currentIdx })}
        />
      )}

      {showBookmarks && (
        <BookmarkModal 
          bookmarks={bookmarks}
          theme={theme}
          onClose={() => setShowBookmarks(false)}
          onAdd={addManualBookmark}
          onDelete={deleteBookmark}
          onJump={(idx) => {
            const updatedBookmarks = createAutoBookmark(currentIdx);
            setBookmarks(updatedBookmarks);
            
            jumpToIdx(idx, updatedBookmarks);
            setShowBookmarks(false);
          }}
          // [Added] 전체 길이 전달 (0으로 나눔 방지 위해 || 1)
          totalLength={fullContent.current.length || 1}
        />
      )}

      {showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => setShowThemeModal(false)}
          theme={theme}
          // [Fix] onSelectTheme prop 추가
          onSelectTheme={(newTheme) => onUpdateSettings({ theme: newTheme })}
        />
      )}

      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={handleUIBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
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
          <button onClick={() => setShowConfirm({ show: true, type: 'input', fromSearch: false, originIdx: currentIdx })} className="text-white/50 hover:text-white"><Hash size={14} /></button>
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
            onMouseUp={() => setShowConfirm({ show: true, type: 'jump', target: currentIdx, fromSearch: false, originIdx: preSlideProgress.current.index })}
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
          
          <button onClick={() => setShowThemeModal(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
             <Palette size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Theme</span>
          </button>

          <button onClick={() => setShowBookmarks(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity text-indigo-500">
            <BookmarkIcon size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">Mark</span>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal settings={settings} onUpdateSettings={onUpdateSettings} onClose={() => setShowSettings(false)} theme={theme} />}
    </div>
  );
};