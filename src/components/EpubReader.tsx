// src/components/EpubReader.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Book, ViewerSettings, Bookmark, UserProgress } from '../types';
import { THEMES } from '../lib/constants';
import { ChevronLeft, Search, Settings, Palette, Bookmark as BookmarkIcon, Hash, RefreshCw, X, Trash2, List } from 'lucide-react';
import { SettingsModal } from './SettingsModal';
import { ThemeModal } from './ThemeModal';
import { BookmarkModal } from './BookmarkModal';
import { TocModal } from './TocModal';
import { EpubSearchModal } from './EpubSearchModal';
import { useEpubReader } from '../hooks/useEpubReader';
import { loadBookFromLocal, saveBookToLocal } from '../lib/localDB';
import { fetchFullFile } from '../lib/googleDrive';

interface EpubReaderProps {
  book: Book;
  googleToken: string;
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[]) => void;
  initialCfi?: string;
  initialPercent?: number;
  remoteProgress?: UserProgress;
}

const EpubReaderInner: React.FC<EpubReaderProps> = ({
  book,
  googleToken,
  settings,
  onUpdateSettings,
  onBack,
  onSaveProgress,
  initialCfi,
  initialPercent,
  remoteProgress,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showJumpInput, setShowJumpInput] = useState(false);
  const [jumpInput, setJumpInput] = useState('');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(remoteProgress?.bookmarks || []);
  const [syncConflict, setSyncConflict] = useState<{ cfi: string; percent: number } | null>(null);
  const hasRestored = useRef(false);
  const lastSaveTime = useRef(Date.now());

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  // 테마별 HEX 색상 (epub 내부 CSS 주입용)
  const THEME_COLORS: Record<string, { bg: string; text: string }> = {
    light: { bg: '#ffffff', text: '#222222' },
    dark: { bg: '#272728', text: '#b8b8b8' },
    sepia: { bg: '#f4ecd8', text: '#5b4636' },
    blue: { bg: '#eef2f7', text: '#2c3e50' },
  };
  const themeColors = THEME_COLORS[settings.theme] || THEME_COLORS.sepia;

  const {
    containerRef,
    isReady,
    totalProgress,
    currentCfi,
    currentChapter,
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
    viewRef,
    setStyle,
    setLayout,
    searchBook,
    clearSearch,
    toc,
  } = useEpubReader({
    initialPercent,
    onRelocate: (detail) => {
      if (detail.cfi) {
        // detail.fraction은 0~1 사이 전체 진행률 — stale closure 방지를 위해 직접 사용
        const pct = detail.fraction !== undefined
          ? Math.min(100, Math.max(0, detail.fraction * 100))
          : 0;
        const now = Date.now();
        if (now - lastSaveTime.current > 5000 && !syncConflict) {
          onSaveProgress(detail.cfi, pct, bookmarks);
          lastSaveTime.current = now;
        }
      }
    },
    onLoad: (doc) => {
      if (!doc) return;
      doc.addEventListener('click', () => {
        setShowControls(prev => !prev);
      });
    },
  });

  // epub 파일 로드
  const loadAttempted = useRef(false);
  useEffect(() => {
    if (loadAttempted.current) return;
    if (!containerRef.current) return;
    loadAttempted.current = true;

    const loadEpub = async () => {
      try {
        const localData = await loadBookFromLocal(book.id);

        let source: Blob;
        const isValidEpub = (buf: ArrayBuffer) => {
          const v = new Uint8Array(buf);
          return v[0] === 0x50 && v[1] === 0x4B;
        };

        if (localData && isValidEpub(localData)) {
          source = new Blob([localData], { type: 'application/epub+zip' });
        } else {
          if (localData) console.warn('[EpubReader] Local data is not valid epub, discarding');
          if (!googleToken) throw new Error('No Token');
          const buffer = await fetchFullFile(book.id, googleToken);
          source = new Blob([buffer], { type: 'application/epub+zip' });
          try {
            await saveBookToLocal(book, buffer);
          } catch (e) {
            console.warn('[EpubReader] Failed to save locally:', e);
          }
        }

        await openBook(source, initialCfi);

        setLayout({
          flow: settings.navMode === 'scroll' ? 'scrolled' : 'paginated',
          maxColumnCount: 1,
          margin: 2,
          maxInlineSize: '1000px',
        });
        setStyle({
          fontSize: settings.fontSize,
          lineHeight: settings.lineHeight,
          fontFamily: settings.fontFamily,
          textAlign: settings.textAlign,
          bgColor: themeColors.bg,
          textColor: themeColors.text,
        });

        setIsLoaded(true);
        hasRestored.current = true;
      } catch (e) {
        console.error('[EpubReader] Failed to load epub:', e);
        onBack();
      }
    };

    loadEpub();
  }, [book.id, googleToken]);

  // settings 변경 시 epub 내부 스타일 즉시 반영
  useEffect(() => {
    if (!isLoaded) return;
    setStyle({
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      fontFamily: settings.fontFamily,
      textAlign: settings.textAlign,
      bgColor: themeColors.bg,
      textColor: themeColors.text,
    });
  }, [isLoaded, settings.fontSize, settings.lineHeight, settings.fontFamily, settings.textAlign, settings.theme, setStyle]);

  // navMode 변경 시 렌더러 flow 변경
  useEffect(() => {
    if (!isLoaded) return;
    setLayout({
      flow: settings.navMode === 'scroll' ? 'scrolled' : 'paginated',
      maxColumnCount: 1,
      margin: 2,
      maxInlineSize: '1000px',
    });
  }, [isLoaded, settings.navMode, setLayout]);

  // 탭 숨김/언마운트 시 저장 (ref 통해 최신값 참조)
  const saveContext = useRef({ onSaveProgress, currentCfi, totalProgress, bookmarks });
  useEffect(() => {
    saveContext.current = { onSaveProgress, currentCfi, totalProgress, bookmarks };
  }, [onSaveProgress, currentCfi, totalProgress, bookmarks]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        const { onSaveProgress, currentCfi, totalProgress, bookmarks } = saveContext.current;
        if (currentCfi) onSaveProgress(currentCfi, totalProgress, bookmarks);
      }
    };
    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      const { onSaveProgress, currentCfi, totalProgress, bookmarks } = saveContext.current;
      if (currentCfi) onSaveProgress(currentCfi, totalProgress, bookmarks);
    };
  }, []);

  // 뒤로가기 핸들링
  const historyPushed = useRef(false);
  useEffect(() => {
    if (!historyPushed.current) {
      window.history.pushState({ panel: 'reader' }, '', '');
      historyPushed.current = true;
    }
    const handlePopState = () => {
      if (showSettings || showThemeModal || showBookmarks || showSearchModal || showJumpInput) {
        window.history.pushState({ panel: 'reader' }, '', '');
        setShowSettings(false);
        setShowThemeModal(false);
        setShowBookmarks(false);
        setShowSearchModal(false);
        setShowJumpInput(false);
      } else {
        onBack();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onBack, showSettings, showThemeModal, showBookmarks, showSearchModal, showJumpInput]);

  // 동기화 충돌 감지
  const lastProcessedRemote = useRef<{ cfi: string; lastRead: number } | null>(null);
  useEffect(() => {
    if (!isLoaded || !remoteProgress) return;
    const remoteTime = remoteProgress.lastRead;
    const remoteCfi = remoteProgress.cfi;

    if (
      lastProcessedRemote.current &&
      lastProcessedRemote.current.cfi === remoteCfi &&
      lastProcessedRemote.current.lastRead === remoteTime
    ) return;

    lastProcessedRemote.current = { cfi: remoteCfi, lastRead: remoteTime };

    if (lastSaveTime.current && Math.abs(remoteTime - lastSaveTime.current) < 5000) return;

    if (remoteCfi && remoteCfi !== currentCfi && remoteTime > lastSaveTime.current) {
      setSyncConflict({ cfi: remoteCfi, percent: remoteProgress.progressPercent });
    }
  }, [remoteProgress, isLoaded, currentCfi]);

  // 탭 네비게이션 (페이지 모드 전용)
  const handleInteraction = useCallback((e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (settings.navMode === 'page') {
      if (clientY > h * 0.7) { next(); return; }
      if (clientY < h * 0.3) { prev(); return; }
    } else if (settings.navMode === 'left-right') {
      if (clientX < w * 0.3) { prev(); return; }
      if (clientX > w * 0.7) { next(); return; }
    } else if (settings.navMode === 'all-dir') {
      if (clientY < h * 0.3) { prev(); return; }
      if (clientY > h * 0.7) { next(); return; }
      if (clientX < w * 0.3) { prev(); return; }
      if (clientX > w * 0.7) { next(); return; }
    }
    setShowControls(c => !c);
  }, [settings.navMode, prev, next]);

  const handleUIBack = () => window.history.back();

  // 현재 페이지 본문 텍스트 추출 (북마크용)
  const getPreviewText = useCallback(() => {
    try {
      const contents = viewRef.current?.renderer?.getContents?.();
      if (!contents || contents.length === 0) return '';
      // 첫 번째 컨텐츠(단일 페이지 또는 왼쪽 페이지)의 텍스트 추출
      const text = contents[0]?.doc?.body?.innerText || '';
      return text.trim().substring(0, 100).replace(/\s+/g, ' ') || '북마크';
    } catch (e) {
      console.warn('[EpubReader] Failed to get preview text:', e);
      return '북마크';
    }
  }, []);

  // 북마크 추가
  const addBookmark = useCallback(() => {
    if (!currentCfi) return;
    const preview = getPreviewText();
    const newMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'manual',
      name: preview,
      cfi: currentCfi,
      progressPercent: totalProgress,
      createdAt: Date.now(),
      color: '#f59e0b',
    };
    const updated = [newMark, ...bookmarks];
    setBookmarks(updated);
    onSaveProgress(currentCfi, totalProgress, updated);
  }, [currentCfi, totalProgress, bookmarks, onSaveProgress, getPreviewText]);

  // 북마크 삭제
  const deleteBookmark = useCallback((id: string) => {
    const updated = bookmarks.filter(b => b.id !== id);
    setBookmarks(updated);
    onSaveProgress(currentCfi, totalProgress, updated);
  }, [bookmarks, currentCfi, totalProgress, onSaveProgress]);

  // 자동 북마크 생성 (큰 폭 이동 시)
  const createAutoBookmark = useCallback((prevCfi: string, prevPct: number) => {
    const preview = getPreviewText();
    const autoMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'auto',
      name: `이전 위치: ${preview}`,
      cfi: prevCfi,
      progressPercent: prevPct,
      createdAt: Date.now(),
      color: '#64748b',
    };

    // 자동 북마크는 최대 5개 유지
    setBookmarks(prev => {
      const manual = prev.filter(b => b.type === 'manual');
      const auto = prev.filter(b => b.type === 'auto').slice(0, 4);
      const updated = [...manual, autoMark, ...auto];
      onSaveProgress(currentCfi, totalProgress, updated);
      return updated;
    });
  }, [getPreviewText, onSaveProgress, currentCfi, totalProgress]);

  // 점프 핸들러 (자동 북마크 로직 포함)
  const performJump = useCallback(async (targetCfi: string) => {
    if (!currentCfi || targetCfi === currentCfi) return;

    // 현재 위치를 자동 북마크로 저장
    createAutoBookmark(currentCfi, totalProgress);

    await goTo(targetCfi);
  }, [currentCfi, totalProgress, createAutoBookmark, goTo]);

  const performJumpFraction = useCallback(async (fraction: number) => {
    const targetPct = fraction * 100;
    // 5% 이상 차이날 때만 자동 북마크 생성
    if (Math.abs(targetPct - totalProgress) > 5) {
      createAutoBookmark(currentCfi, totalProgress);
    }
    await goToFraction(fraction);
  }, [currentCfi, totalProgress, createAutoBookmark, goToFraction]);

  // % 또는 CFI로 이동
  const handleJump = useCallback(() => {
    const trimmed = jumpInput.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('epubcfi(')) {
      performJump(trimmed);
    } else {
      const pct = parseFloat(trimmed.replace('%', ''));
      if (!isNaN(pct)) performJumpFraction(Math.min(100, Math.max(0, pct)) / 100);
    }
    setShowJumpInput(false);
    setJumpInput('');
  }, [jumpInput, performJump, performJumpFraction]);

  return (
    <div className={`h-screen w-screen ${theme.bg} ${theme.text} transition-colors duration-300 select-none overflow-hidden`}>
      {/* 로딩 오버레이 */}
      {!isLoaded && (
        <div className={`absolute inset-0 z-[100] flex items-center justify-center ${theme.bg} text-xs font-black uppercase opacity-20 tracking-widest`}>
          Loading...
        </div>
      )}

      {/* Epub Viewer Container */}
      <div ref={containerRef} className="w-full h-full" style={{ position: 'relative' }} />

      {/* 탭 오버레이 (페이지 모드 전용) */}
      {isLoaded && settings.navMode !== 'scroll' && (
        <div className="fixed inset-0 z-10" style={{ background: 'transparent' }} onClick={handleInteraction} />
      )}

      {/* Top Navbar */}
      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={handleUIBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.epub', '').replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      {/* Bottom Controls */}
      <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
        {/* 진행률 표시 + % 입력 버튼 */}
        <div className={`absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-6 py-2.5 rounded-full border border-white/10 shadow-xl flex items-center gap-3 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <span className="text-[10px] font-black text-white tracking-widest font-sans">
            {currentChapter || 'Reading'}
            <span className="ml-2 text-accent-400">{(totalProgress || 0).toFixed(1)}%</span>
          </span>
          <button onClick={() => { setShowJumpInput(true); setShowControls(false); }} className="text-white/50 hover:text-white transition-colors">
            <Hash size={14} />
          </button>
        </div>

        {/* 프로그레스 슬라이더 + 검색 버튼 */}
        <div className="max-w-lg mx-auto px-6 pt-6 pb-2 flex items-center gap-4">
          <input
            type="range" min="0" max="100" step="0.1" value={totalProgress || 0}
            onChange={(e) => {
              const p = parseFloat(e.target.value);
              // 슬라이더 이동은 자동 북마크 없이 직접 이동
              goToFraction(p / 100);
            }}
            className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-accent-500"
          />
          <button onClick={() => { setShowSearchModal(true); setShowControls(false); }} className="p-2 -mr-2 opacity-60 hover:opacity-100 transition-opacity">
            <Search size={22} />
          </button>
        </div>

        {/* 하단 버튼들 */}
        <div className="flex justify-around p-5 max-w-lg mx-auto font-sans">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button onClick={() => setShowThemeModal(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Palette size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Theme</span>
          </button>
          <button
            onClick={() => setShowBookmarks(true)}
            className={`flex flex-col items-center gap-1.5 transition-opacity ${bookmarks.length > 0 ? 'text-accent-500 opacity-100' : 'opacity-60 hover:opacity-100'}`}
          >
            <BookmarkIcon size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">
              Mark{bookmarks.length > 0 ? ` (${bookmarks.length})` : ''}
            </span>
          </button>
          <button onClick={() => setShowToc(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <List size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Index</span>
          </button>
        </div>
      </div>

      {/* 설정 모달 */}
      {showSettings && <SettingsModal settings={settings} onUpdateSettings={onUpdateSettings} onClose={() => setShowSettings(false)} theme={theme} />}

      {/* 테마 모달 */}
      {showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => setShowThemeModal(false)}
          theme={theme}
          onSelectTheme={(newTheme) => onUpdateSettings({ theme: newTheme })}
        />
      )}

      {/* 북마크 목록 모달 */}
      {showBookmarks && (
        <BookmarkModal
          bookmarks={bookmarks}
          theme={theme}
          onClose={() => setShowBookmarks(false)}
          onAdd={addBookmark}
          onDelete={deleteBookmark}
          onJump={(cfi) => { performJump(cfi); setShowBookmarks(false); }}
        />
      )}

      {/* 목차 모달 */}
      {showToc && (
        <TocModal
          toc={toc}
          theme={theme}
          onClose={() => setShowToc(false)}
          onJump={(href) => { performJump(href); setShowToc(false); }}
          currentChapter={currentChapter}
        />
      )}

      {/* 검색 모달 */}
      {showSearchModal && (
        <EpubSearchModal
          theme={theme}
          onClose={() => setShowSearchModal(false)}
          onSelect={(cfi) => { performJump(cfi); setShowSearchModal(false); }}
          onSearch={searchBook}
          onClear={clearSearch}
        />
      )}

      {/* % / CFI 이동 입력창 */}
      {showJumpInput && (
        <div className="fixed inset-0 z-[120] flex items-end" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => { setShowJumpInput(false); setJumpInput(''); }}>
          <div className={`w-full ${theme.bg} rounded-t-2xl p-6`} onClick={e => e.stopPropagation()}>
            <h3 className="font-bold mb-3 text-sm">위치로 이동</h3>
            <p className="text-xs opacity-50 mb-4">퍼센트 (예: 42.5) 또는 CFI 값을 입력하세요</p>
            <div className="flex gap-3">
              <input
                autoFocus
                type="text"
                value={jumpInput}
                onChange={e => setJumpInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleJump(); if (e.key === 'Escape') { setShowJumpInput(false); setJumpInput(''); } }}
                placeholder="예: 42.5 또는 epubcfi(...)"
                className={`flex-1 px-4 py-3 rounded-xl text-sm border ${theme.border} bg-transparent outline-none focus:ring-2 focus:ring-accent-500`}
              />
              <button onClick={handleJump} className="px-5 py-3 rounded-xl bg-accent-500 text-white font-bold text-sm hover:bg-accent-600 transition-colors">
                이동
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 동기화 알림 다이얼로그 */}
      {syncConflict && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className={`${theme.bg} rounded-2xl p-6 shadow-2xl border border-white/10 w-full max-w-sm`}>
            <div className="flex items-center gap-3 text-accent-500 mb-2">
              <RefreshCw size={22} />
              <h3 className="text-lg font-bold tracking-tight">클라우드 동기화</h3>
            </div>
            <p className={`text-sm opacity-80 mb-6 leading-relaxed`}>
              다른 기기에서 <span className="font-bold text-accent-500">{syncConflict.percent.toFixed(1)}%</span>까지 읽은 기록이 있습니다.<br />해당 위치로 이동하시겠습니까?
            </p>
            <div className="flex gap-3">
              <button onClick={() => setSyncConflict(null)} className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-gray-500/10 hover:bg-gray-500/20 transition-colors">
                무시
              </button>
              <button
                onClick={() => { performJump(syncConflict.cfi); setSyncConflict(null); }}
                className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-lg shadow-accent-500/30"
              >
                이동하기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EpubReaderInner;
