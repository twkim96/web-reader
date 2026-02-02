// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings, Bookmark } from '../types';
import { THEMES } from '../lib/constants';
import { SettingsModal } from './SettingsModal';
import { SearchModal } from './SearchModal';
import { BookmarkModal } from './BookmarkModal';
import { ThemeModal } from './ThemeModal'; 
import { ChevronLeft, Settings, Palette, Hash, Search, ArrowUpCircle, Bookmark as BookmarkIcon } from 'lucide-react';

// Hooks
import { useBookLoader } from '../hooks/useBookLoader';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { useVirtualScroll } from '../hooks/useVirtualScroll';

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
  // 1. Data Loading
  const { isLoaded, fullContent } = useBookLoader(book, googleToken, settings, onBack);

  // 2. Reading Progress & State
  const { 
    currentIdx, setCurrentIdx,
    readPercent, setReadPercent,
    bookmarks, setBookmarks,
    syncConflict, setSyncConflict,
    createAutoBookmark, addManualBookmark, deleteBookmark,
    lastSaveTime, hasRestored
  } = useReadingProgress({ initialProgress, fullContentRef: fullContent, onSaveProgress, isLoaded });

  // 3. Virtual Scroll
  const { 
    paddingTop, blockRefs, getVisibleBlocks, jumpToIdx, isJumping 
  } = useVirtualScroll({ 
    fullContentRef: fullContent, 
    isLoaded, 
    hasRestored: hasRestored.current === book.id,
    currentIdx,
    // [Added] 레이아웃에 영향을 주는 설정값들을 전달하여 변경 시 위치 재보정
    layoutDeps: [
      settings.fontSize, 
      settings.lineHeight, 
      settings.fontFamily, 
      settings.padding, 
      settings.textAlign
    ],
    onScrollProgress: (idx, pct) => {
      setCurrentIdx(idx);
      setReadPercent(pct);
      
      const now = Date.now();
      if (now - lastSaveTime.current > 5000 && !syncConflict) {
        onSaveProgress(idx, pct, bookmarks);
        lastSaveTime.current = now;
      }
    }
  });

  // UI States
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  
  const [showConfirm, setShowConfirm] = useState<{
    show: boolean, type: 'jump' | 'input', target?: number, fromSearch?: boolean, originIdx?: number 
  }>({ show: false, type: 'jump' });
  
  const [jumpInput, setJumpInput] = useState("");
  const preSlideProgress = useRef({ percent: 0, index: 0 });
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  // --- History & Back Button Handling ---

  const stateRef = useRef({
    showSettings,
    showSearch,
    showBookmarks,
    showThemeModal,
    showConfirm,
    syncConflict
  });

  useEffect(() => {
    stateRef.current = { showSettings, showSearch, showBookmarks, showThemeModal, showConfirm, syncConflict };
  }, [showSettings, showSearch, showBookmarks, showThemeModal, showConfirm, syncConflict]);

  useEffect(() => {
    window.history.pushState({ panel: 'reader' }, '', '');

    const handlePopState = (event: PopStateEvent) => {
      const { showSettings, showSearch, showBookmarks, showThemeModal, showConfirm, syncConflict } = stateRef.current;
      
      const isAnyModalOpen = showSettings || showSearch || showBookmarks || showThemeModal || showConfirm.show || syncConflict;

      if (isAnyModalOpen) {
        window.history.pushState({ panel: 'reader' }, '', '');

        if (showSettings) setShowSettings(false);
        if (showSearch) setShowSearch(false);
        if (showBookmarks) setShowBookmarks(false);
        if (showThemeModal) setShowThemeModal(false);
        if (syncConflict) setSyncConflict(null);
        
        if (showConfirm.show) {
          if (!showConfirm.fromSearch && showConfirm.type === 'jump') {
            setReadPercent(preSlideProgress.current.percent);
            setCurrentIdx(preSlideProgress.current.index);
          }
          setShowConfirm(prev => ({ ...prev, show: false }));
          setJumpInput("");
        }
      } else {
        onBack();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => { window.removeEventListener('popstate', handlePopState); };
  }, [onBack, setSyncConflict, setCurrentIdx, setReadPercent]);

  // --- Initial Restore & Jump ---

  useEffect(() => {
    if (!isLoaded || hasRestored.current === book.id) return;
    if (initialProgress) {
      if (initialProgress.charIndex > 0) {
        setCurrentIdx(initialProgress.charIndex);
        setReadPercent(initialProgress.progressPercent);
        jumpToIdx(initialProgress.charIndex);
      }
      hasRestored.current = book.id;
    } else if (isLoaded) {
      hasRestored.current = book.id;
    }
  }, [isLoaded, initialProgress, book.id, jumpToIdx, setCurrentIdx, setReadPercent, hasRestored]);

  // --- Handlers ---

  const handleUIBack = () => { window.history.back(); };

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

    if (showConfirm.originIdx !== undefined) {
      updatedBookmarks = createAutoBookmark(showConfirm.originIdx);
      setBookmarks(updatedBookmarks); 
    }

    const bookmarksToSave = updatedBookmarks || bookmarks;

    if (showConfirm.type === 'jump' && showConfirm.target !== undefined) {
      setCurrentIdx(showConfirm.target);
      const newPercent = (showConfirm.target / (fullContent.current.length || 1)) * 100;
      setReadPercent(newPercent);
      
      onSaveProgress(showConfirm.target, newPercent, bookmarksToSave);
      lastSaveTime.current = Date.now();
      
      jumpToIdx(showConfirm.target);
      if (showConfirm.fromSearch) setShowSearch(false);

    } else if (showConfirm.type === 'input') {
      let idx = 0;
      if (jumpInput.includes('%')) {
        const p = parseFloat(jumpInput.replace('%', ''));
        if (!isNaN(p)) idx = Math.floor((p / 100) * (fullContent.current.length || 1));
      } else {
        idx = parseInt(jumpInput.replace(/,/g, ''));
      }

      if (!isNaN(idx)) {
        setCurrentIdx(idx);
        const newPercent = (idx / (fullContent.current.length || 1)) * 100;
        setReadPercent(newPercent);

        onSaveProgress(idx, newPercent, bookmarksToSave);
        lastSaveTime.current = Date.now();

        jumpToIdx(idx);
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
      
      setCurrentIdx(syncConflict.remoteIdx);
      setReadPercent(syncConflict.remotePercent);
      
      onSaveProgress(syncConflict.remoteIdx, syncConflict.remotePercent, updatedBookmarks);
      lastSaveTime.current = Date.now();
      
      jumpToIdx(syncConflict.remoteIdx);
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

  const handleSlideEnd = () => {
    setShowConfirm({ 
      show: true, 
      type: 'jump', 
      target: currentIdx, 
      fromSearch: false, 
      originIdx: preSlideProgress.current.index 
    });
  };

  if (!isLoaded) return <div className={`h-screen w-screen flex items-center justify-center ${theme.bg} text-xs font-black uppercase opacity-20 tracking-widest`}>Loading...</div>;

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} transition-colors duration-300 ${getFontClass()} select-none`}>
      {/* Confirm Modal */}
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

      {/* Sync Conflict Modal */}
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

      {/* Search Modal */}
      {showSearch && (
        <SearchModal 
          content={fullContent.current} 
          theme={theme} 
          onClose={() => setShowSearch(false)} 
          onSelect={(idx) => setShowConfirm({ show: true, type: 'jump', target: idx, fromSearch: true, originIdx: currentIdx })}
        />
      )}

      {/* Bookmark Modal */}
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

            setCurrentIdx(idx);
            setReadPercent((idx / (fullContent.current.length || 1)) * 100);
            
            onSaveProgress(idx, (idx / (fullContent.current.length || 1)) * 100, updatedBookmarks);
            lastSaveTime.current = Date.now();

            jumpToIdx(idx);
            setShowBookmarks(false);
          }}
          totalLength={fullContent.current.length || 1}
        />
      )}

      {/* Theme Modal */}
      {showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => setShowThemeModal(false)}
          theme={theme}
          onSelectTheme={(newTheme) => onUpdateSettings({ theme: newTheme })}
        />
      )}

      {/* Top Navbar */}
      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={handleUIBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      {/* Main Reader View */}
      <main onClick={handleInteraction} className="min-h-screen pt-12 pb-96 relative" style={{ paddingLeft: `${settings.padding}px`, paddingRight: `${settings.padding}px`, textAlign: settings.textAlign }}>
        <div style={{ height: `${paddingTop}px` }} />
        <div className="max-w-3xl mx-auto whitespace-pre-wrap break-words" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>
          {getVisibleBlocks().map(block => (
            <div key={`${book.id}-${block.index}`} ref={el => { blockRefs.current[block.index] = el; }}>{block.text}</div>
          ))}
        </div>
      </main>

      {/* Bottom Controls */}
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
            onTouchStart={() => { preSlideProgress.current = { percent: readPercent, index: currentIdx }; }}
            onChange={(e) => {
              const p = parseFloat(e.target.value);
              setReadPercent(p);
              setCurrentIdx(Math.floor((p / 100) * (fullContent.current.length || 1)));
            }}
            onMouseUp={handleSlideEnd}
            onTouchEnd={handleSlideEnd}
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