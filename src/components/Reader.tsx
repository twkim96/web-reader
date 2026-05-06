// src/components/Reader.tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings, Bookmark } from '../types';
import { THEMES } from '../lib/constants';
import { SettingsModal } from './SettingsModal';
import { SearchModal } from './SearchModal';
import { BookmarkModal } from './BookmarkModal';
import { ThemeModal } from './ThemeModal'; 
import { ChevronLeft, Settings, Palette, Hash, Search, ArrowUpCircle, Bookmark as BookmarkIcon, Cloud } from 'lucide-react';

// Hooks
import { useBookLoader } from '../hooks/useBookLoader';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { useVirtualScroll } from '../hooks/useVirtualScroll';

interface ReaderProps {
  book: Book;
  googleToken: string;
  initialProgress?: UserProgress;
  remoteProgress?: UserProgress;
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (idx: number, pct: number, bookmarks?: Bookmark[]) => void;
}

export const Reader: React.FC<ReaderProps> = ({ 
  book, googleToken, initialProgress, remoteProgress, settings, onUpdateSettings, onBack, onSaveProgress 
}) => {
  // 1. Data Loading
  const { isLoaded, fullContent, contentVersion } = useBookLoader(book, googleToken, settings, onBack);

  // 2. Reading Progress & State
  const { 
    currentIdx, setCurrentIdx,
    readPercent, setReadPercent,
    bookmarks, setBookmarks,
    syncConflict, setSyncConflict,
    createAutoBookmark, addManualBookmark, deleteBookmark,
    lastSaveActionTime, hasRestored, autoSyncToast, triggerSave, resolveConflict,
    jumpRequest, setJumpRequest
  } = useReadingProgress({ initialProgress, remoteProgress, fullContentRef: fullContent, onSaveProgress, isLoaded });

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
      settings.textAlign,
      contentVersion
    ],
    onScrollProgress: (idx, pct) => {
      setCurrentIdx(idx);
      setReadPercent(pct);
      
      const now = Date.now();
      if (now - lastSaveActionTime.current > 5000 && !syncConflict) {
        triggerSave(idx, pct, bookmarks);
      }
    }
  });

  // UI States
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);

  // [Added] jumpRequest 처리
  useEffect(() => {
    if (jumpRequest !== null) {
      jumpToIdx(jumpRequest);
      setJumpRequest(null);
    }
  }, [jumpRequest, jumpToIdx, setJumpRequest]);

  // [Added] 동적 마스킹(잘림 방지) 기능을 위한 하단 여백 높이 상태 및 실측 줄 높이
  const [maskHeight, setMaskHeight] = useState(0);
  const measureRef = useRef<HTMLDivElement>(null);
  const [actualLineHeight, setActualLineHeight] = useState(settings.fontSize * settings.lineHeight);

  useEffect(() => {
    if (measureRef.current) {
      const h = measureRef.current.getBoundingClientRect().height;
      if (h > 0) setActualLineHeight(h);
    }
  }, [settings.fontSize, settings.lineHeight, settings.fontFamily]);

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

    // [x] 페이지 단위 스크롤을 위한 다이내믹 패딩(마스크) 추가
    // [x] 스크롤 종료 후 가까운 줄로 스냅되는 `scrollend` 로직 (300ms Debounce)
    // [x] 탭스크롤 시 스냅 포인트 연동 및 정확도 100% 달성

    window.addEventListener('popstate', handlePopState);
    return () => { window.removeEventListener('popstate', handlePopState); };
  }, [onBack, setSyncConflict, setCurrentIdx, setReadPercent]);

  // --- Smart Scrolling & Masking ---
  const getGridSnapY = useCallback((targetY: number) => {
    const lh = actualLineHeight;
    let baseTop = 48; // 기본 패딩 48px
    
    // 상단 고정 여백 (너무 딱 달라붙지 않게 fontSize의 1.2배 정도)
    const topPadding = Math.round(settings.fontSize * 1.2); 
    
    // Virtual Scroll의 누적 오차(paddingTop)를 피하기 위해, 실제 DOM 요소의 절대 좌표를 그리드 기준으로 삼음
    const blocks = getVisibleBlocks();
    if (blocks.length === 0) return 0;
    
    const firstElem = blockRefs.current[blocks[0].index];
    if (firstElem) {
      baseTop = window.scrollY + firstElem.getBoundingClientRect().top;
    }
    
    if (targetY < 48) return 0;

    // 1. 수학적 그리드 스냅 타겟 계산 (targetY 위치에 있을 때 topPadding 위치에 올 텍스트 라인)
    const snapTarget = Math.round((targetY + topPadding - baseTop) / lh) * lh + baseTop;
    
    // 2. snapTarget(문서 절대 Y좌표)부터 시작해서 가장 처음 만나는 "실제 텍스트(공백 아님)"를 찾음
    let actualTextDocY = snapTarget;
    
    for (const block of blocks) {
      const blockElem = blockRefs.current[block.index];
      if (!blockElem) continue;
      
      const blockRect = blockElem.getBoundingClientRect();
      const blockDocBottom = window.scrollY + blockRect.bottom;
      
      // 블록 전체가 snapTarget보다 위에 있으면 스킵 (소수점 오차 감안 -2px)
      if (blockDocBottom < snapTarget - 2) continue;
      
      const walk = document.createTreeWalker(blockElem, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      let found = false;

      while ((node = walk.nextNode())) {
        const text = node.nodeValue || "";
        if (text.trim() === "") continue; 

        const range = document.createRange();
        range.selectNodeContents(node);
        const nodeDocBottom = window.scrollY + range.getBoundingClientRect().bottom;
        
        if (nodeDocBottom < snapTarget - 2) continue;

        let low = 0;
        let high = text.length - 1;
        let firstVisibleIdx = -1;

        // 이진 탐색으로 snapTarget 라인에 걸치는 첫 글자를 찾음
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          try {
            range.setStart(node, mid);
            range.setEnd(node, mid + 1);
            const rect = range.getBoundingClientRect();
            const docBottom = window.scrollY + rect.bottom;

            if (docBottom >= snapTarget - 2) {
              firstVisibleIdx = mid;
              high = mid - 1; 
            } else {
              low = mid + 1;
            }
          } catch(e) { break; }
        }

        // 해당 글자부터 순차 탐색하여 공백이 아닌 실제 문자를 찾음
        if (firstVisibleIdx !== -1) {
          for (let i = firstVisibleIdx; i < text.length; i++) {
            if (text[i].trim() === "") continue;
            
            try {
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const rect = range.getBoundingClientRect();
              actualTextDocY = window.scrollY + rect.top;
              found = true;
              break;
            } catch(e) { break; }
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    return Math.max(0, actualTextDocY - topPadding);
  }, [settings.fontSize, actualLineHeight, getVisibleBlocks, blockRefs]);

  const snapTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const snapFuncRef = useRef(getGridSnapY);
  useEffect(() => { snapFuncRef.current = getGridSnapY; }, [getGridSnapY]);

  useEffect(() => {
    const updateMaskAndSnap = () => {
      const lh = actualLineHeight;
      const h = document.documentElement.clientHeight || window.innerHeight;
      const topPadding = Math.round(settings.fontSize * 1.2);
      const lines = Math.floor((h - topPadding) / lh);
      setMaskHeight(Math.max(0, h - (lines * lh) - topPadding));
    };

    const handleScroll = () => {
      clearTimeout(snapTimerRef.current);
      snapTimerRef.current = setTimeout(() => {
        // 사용자가 수동으로 스와이프를 멈췄을 때 가장 가까운 라인에 맞게 스냅(이동) 
        if (isJumping.current) return;
        
        const currentY = window.scrollY;
        const snapY = snapFuncRef.current(currentY);
        
        if (Math.abs(snapY - currentY) > 2) { 
          window.scrollTo({ top: snapY, behavior: 'smooth' });
        }
      }, 300); // 스크롤이 완전히 멈춘 후 대기시간 (300ms)
    };

    updateMaskAndSnap();
    window.addEventListener('resize', updateMaskAndSnap);
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    return () => {
      window.removeEventListener('resize', updateMaskAndSnap);
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(snapTimerRef.current);
    };
  }, [settings.fontSize, actualLineHeight, isJumping]); // getGridSnapY 제거 (리렌더링 간섭 방지)

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
    const h = document.documentElement.clientHeight || window.innerHeight;
    
    // [Modified] 정확한 줄 단위 이동을 위한 계산 (상단 고정 여백 반영)
    const oneLineHeight = actualLineHeight;
    const topPadding = Math.round(settings.fontSize * 1.2);
    const linesPerScreen = Math.floor((h - topPadding) / oneLineHeight);
    const scrollStep = linesPerScreen * oneLineHeight; 

    // [Modified] 이동 시 그리드 스냅 적용
    const move = (dir: number) => { 
      const currentScrollY = window.scrollY;
      const targetScrollY = currentScrollY + (dir * scrollStep);
      
      const snappedY = getGridSnapY(targetScrollY);
      window.scrollTo({ top: Math.max(0, snappedY), behavior: 'instant' }); 
    };

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
      
      triggerSave(showConfirm.target, newPercent, bookmarksToSave);
      
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

        triggerSave(idx, newPercent, bookmarksToSave);

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
      
      triggerSave(syncConflict.remoteIdx, syncConflict.remotePercent, updatedBookmarks);
      
      jumpToIdx(syncConflict.remoteIdx);
      resolveConflict(false);
    } else {
      resolveConflict(true);
    }
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
              <input autoFocus type="text" value={jumpInput} onChange={(e) => setJumpInput(e.target.value)} placeholder="50% 또는 100000" className="w-full bg-black/5 dark:bg-white/5 border border-white/10 rounded-xl p-3 mb-6 text-center outline-none focus:ring-2 ring-accent-500" />
            )}
            <div className="flex gap-3">
              <button onClick={cancelJump} className="flex-1 py-3 bg-red-500/10 text-red-500 font-bold rounded-2xl transition-colors">취소</button>
              <button onClick={confirmJump} className="flex-1 py-3 bg-accent-500 text-white font-bold rounded-2xl shadow-lg shadow-accent-500/30 transition-transform active:scale-95">이동</button>
            </div>
          </div>
        </div>
      )}

      {/* Auto Sync Toast */}
      {autoSyncToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-accent-600/95 text-white px-5 py-3 rounded-full text-[11px] font-black tracking-widest shadow-2xl backdrop-blur-md animate-in slide-in-from-top-4 fade-in duration-500 z-[100] flex items-center gap-2">
          <Cloud size={16} />
          클라우드 위치로 갱신됨
        </div>
      )}

      {/* Sync Conflict Modal */}
      {syncConflict && (
         <div className="fixed z-[100] max-w-sm w-[90%] md:w-full animate-in duration-500 bottom-24 left-1/2 -translate-x-1/2 md:top-auto md:left-auto md:bottom-24 md:right-6 md:translate-x-0 zoom-in-95 md:zoom-in-100 md:slide-in-from-right">
          <div className="bg-slate-900/90 text-white backdrop-blur-md p-4 rounded-3xl shadow-2xl border border-white/10 flex flex-col gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-accent-500/20 rounded-full text-accent-400"><ArrowUpCircle size={20} /></div>
              <div className="flex-1">
                <h4 className="text-sm font-bold">원격 기록 발견</h4>
                <p className="text-xs text-slate-400 mt-1 leading-relaxed">다른 기기에서 <span className="text-accent-400 font-bold">{syncConflict.remotePercent.toFixed(1)}%</span>까지 읽은 기록이 있습니다. 동기화하시겠습니까?</p>
              </div>
            </div>
            <div className="flex gap-2 pl-11">
              <button onClick={() => handleSyncResolve('ignore')} className="flex-1 py-2 text-xs font-bold text-slate-400 hover:bg-white/5 rounded-xl transition-colors">무시하기</button>
              <button onClick={() => handleSyncResolve('sync')} className="flex-1 py-2 text-xs font-bold bg-accent-600 hover:bg-accent-500 rounded-xl shadow-lg shadow-accent-500/20 transition-colors">동기화 (이동)</button>
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
            
            triggerSave(idx, (idx / (fullContent.current.length || 1)) * 100, updatedBookmarks);

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
        {/* 숨김 처리된 더미 텍스트 (실제 렌더링되는 한 줄의 높이 측정용) */}
        <div 
          ref={measureRef} 
          style={{ position: 'absolute', visibility: 'hidden', fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight, pointerEvents: 'none' }}
        >
          A
        </div>
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
            <span className="ml-2 text-accent-400">{readPercent.toFixed(1)}%</span>
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
            className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-accent-500"
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

          <button onClick={() => setShowBookmarks(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity text-accent-500">
            <BookmarkIcon size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">Mark</span>
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal settings={settings} onUpdateSettings={onUpdateSettings} onClose={() => setShowSettings(false)} theme={theme} />}

      {/* Dynamic Masking: 하단 텍스트 잘림 현상 방지용 배경색 블록 */}
      <div 
        className={`fixed bottom-0 inset-x-0 pointer-events-none z-40 transition-colors ${theme.bg}`} 
        style={{ height: `${maskHeight}px` }} 
      />
    </div>
  );
};