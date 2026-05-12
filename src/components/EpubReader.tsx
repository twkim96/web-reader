// src/components/EpubReader.tsx
'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Book, ViewerSettings, Bookmark } from '../types';
import { THEMES } from '../lib/constants';
import { ChevronLeft, Search, Settings, Palette, Bookmark as BookmarkIcon, Hash } from 'lucide-react';
import { SettingsModal } from './SettingsModal';
import { ThemeModal } from './ThemeModal';
import { useEpubReader } from '../hooks/useEpubReader';
import { loadBookFromLocal } from '../lib/localDB';
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
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const hasRestored = useRef(false);

  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

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
  } = useEpubReader({
    onRelocate: (detail) => {
      // 주기적 저장 (5초마다)
      if (detail.cfi) {
        const now = Date.now();
        if (now - lastSaveTime.current > 5000) {
          onSaveProgress(detail.cfi, totalProgress);
          lastSaveTime.current = now;
        }
      }
    },
  });

  const lastSaveTime = useRef(Date.now());

  // epub 파일 로드
  useEffect(() => {
    if (!isReady) return;
    
    const loadEpub = async () => {
      try {
        // 1. 로컬에서 먼저 시도
        const localData = await loadBookFromLocal(book.id);
        
        let source: Blob;
        if (localData) {
          source = new Blob([localData], { type: 'application/epub+zip' });
        } else {
          // 2. Google Drive에서 다운로드
          if (!googleToken) throw new Error('No Token');
          const buffer = await fetchFullFile(book.id, googleToken);
          source = new Blob([buffer], { type: 'application/epub+zip' });
        }

        await openBook(source);
        setIsLoaded(true);

        // 초기 위치 복원
        if (initialCfi && !hasRestored.current) {
          setTimeout(() => {
            goTo(initialCfi);
            hasRestored.current = true;
          }, 300);
        }
      } catch (e) {
        console.error('Failed to load epub:', e);
        onBack();
      }
    };

    loadEpub();
  }, [isReady, book.id, googleToken]);

  // 탭 숨김/언마운트 시 저장
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && currentCfi) {
        onSaveProgress(currentCfi, totalProgress);
      }
    };

    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      // 언마운트 시 최종 저장
      if (currentCfi) {
        onSaveProgress(currentCfi, totalProgress);
      }
    };
  }, [currentCfi, totalProgress, onSaveProgress]);

  // 뒤로가기 핸들링
  useEffect(() => {
    window.history.pushState({ panel: 'reader' }, '', '');

    const handlePopState = () => {
      if (showSettings || showThemeModal) {
        window.history.pushState({ panel: 'reader' }, '', '');
        setShowSettings(false);
        setShowThemeModal(false);
      } else {
        onBack();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onBack, showSettings, showThemeModal]);

  // 탭 네비게이션
  const handleInteraction = useCallback((e: React.MouseEvent) => {
    const { clientX, clientY } = e;
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (settings.navMode !== 'scroll') {
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
    }
    setShowControls(!showControls);
  }, [settings.navMode, showControls, prev, next]);

  const handleUIBack = () => window.history.back();

  if (!isLoaded) {
    return (
      <div className={`h-screen w-screen flex items-center justify-center ${theme.bg} text-xs font-black uppercase opacity-20 tracking-widest`}>
        Loading...
      </div>
    );
  }

  return (
    <div className={`h-screen w-screen ${theme.bg} ${theme.text} transition-colors duration-300 select-none overflow-hidden`}>
      {/* Epub Viewer Container */}
      <div
        ref={containerRef}
        onClick={handleInteraction}
        className="w-full h-full"
        style={{ position: 'relative' }}
      />

      {/* Top Navbar */}
      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={handleUIBack} className="p-2 rounded-full hover:bg-black/5 transition-colors"><ChevronLeft /></button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.epub', '').replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      {/* Bottom Controls */}
      <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
        {/* 진행률 표시 */}
        <div className={`absolute -top-16 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md px-6 py-2.5 rounded-full border border-white/10 shadow-xl flex items-center gap-3 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <span className="text-[10px] font-black text-white tracking-widest font-sans">
            {currentChapter || 'Reading'}
            <span className="ml-2 text-accent-400">{totalProgress.toFixed(1)}%</span>
          </span>
        </div>

        {/* 프로그레스 슬라이더 */}
        <div className="max-w-lg mx-auto px-6 pt-6 pb-2 flex items-center gap-4">
          <input
            type="range" min="0" max="100" step="0.1" value={totalProgress}
            onChange={(e) => {
              const p = parseFloat(e.target.value);
              goToFraction(p / 100);
            }}
            className="flex-1 h-1.5 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-accent-500"
          />
        </div>

        {/* 하단 버튼들 */}
        <div className="flex justify-around p-5 max-w-lg mx-auto font-sans">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button onClick={() => setShowThemeModal(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Palette size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Theme</span>
          </button>
          <button className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity text-accent-500">
            <BookmarkIcon size={22} /><span className="text-[9px] font-bold uppercase tracking-tighter">Mark</span>
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
    </div>
  );
};

export default EpubReaderInner;
