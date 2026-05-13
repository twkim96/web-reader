// src/components/EpubReader.tsx
'use client';

import React, { useCallback, useEffect, useMemo } from 'react';
import { Book, Bookmark, SaveProgressOptions, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { SettingsModal } from './SettingsModal';
import { ThemeModal } from './ThemeModal';
import { BookmarkModal } from './BookmarkModal';
import { TocModal } from './TocModal';
import { EpubSearchModal } from './EpubSearchModal';
import { JumpDialog } from './reader/JumpDialog';
import { ReaderToolbar } from './reader/ReaderToolbar';
import { SyncConflictDialog } from './reader/SyncConflictDialog';
import { useEpubReader } from '../hooks/useEpubReader';
import { useReaderBookSource } from '../hooks/reader/useReaderBookSource';
import { useReaderBookmarks } from '../hooks/reader/useReaderBookmarks';
import { useReaderChrome } from '../hooks/reader/useReaderChrome';
import { useReaderProgressSave } from '../hooks/reader/useReaderProgressSave';
import { useReaderProgressSlider } from '../hooks/reader/useReaderProgressSlider';
import { useRemoteProgressPrompt } from '../hooks/reader/useRemoteProgressPrompt';

interface EpubReaderProps {
  book: Book;
  googleToken: string;
  settings: ViewerSettings;
  onUpdateSettings: (settings: Partial<ViewerSettings>) => void;
  onBack: () => void;
  onSaveProgress: (cfi: string, pct: number, bookmarks?: Bookmark[], options?: SaveProgressOptions) => void;
  initialCfi?: string;
  initialPercent?: number;
  initialTime?: number;
  initialBookmarks?: Bookmark[];
  remoteProgress?: UserProgress;
}

const THEME_COLORS: Record<string, { bg: string; text: string }> = {
  light: { bg: '#ffffff', text: '#222222' },
  dark: { bg: '#272728', text: '#b8b8b8' },
  sepia: { bg: '#f4ecd8', text: '#5b4636' },
  blue: { bg: '#eef2f7', text: '#2c3e50' },
};

const EpubReaderInner: React.FC<EpubReaderProps> = ({
  book,
  googleToken,
  settings,
  onUpdateSettings,
  onBack,
  onSaveProgress,
  initialCfi,
  initialPercent,
  initialTime,
  initialBookmarks,
  remoteProgress,
}) => {
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;
  const themeColors = useMemo(() => THEME_COLORS[settings.theme] || THEME_COLORS.sepia, [settings.theme]);

  const chrome = useReaderChrome({ onBack });
  const {
    lastSaveTimeRef,
    updateSaveContext,
    markUserProgressChange,
    saveProgressIfChanged,
    handleRelocateForSave,
    saveCurrentProgress,
    prepareRemoteJump,
    completeRemoteJump,
  } = useReaderProgressSave({
    initialCfi,
    initialPercent,
    initialTime,
    initialBookmarks,
    onSaveProgress,
  });

  const handleReaderLoad = useCallback((doc?: Document) => {
    if (!doc) return;
    doc.addEventListener('click', chrome.toggleControls);
    doc.addEventListener('wheel', () => markUserProgressChange(), { passive: true });
    doc.addEventListener('touchmove', () => markUserProgressChange(), { passive: true });
    doc.addEventListener('keydown', () => markUserProgressChange());
  }, [chrome.toggleControls, markUserProgressChange]);

  const {
    containerRef,
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
    onRelocate: handleRelocateForSave,
    onLoad: handleReaderLoad,
  });

  const { isLoaded } = useReaderBookSource({
    book,
    googleToken,
    initialCfi,
    settings,
    themeColors,
    containerRef,
    openBook,
    setLayout,
    setStyle,
    onBack,
  });

  const {
    bookmarks,
    getBookmarks,
    addBookmark,
    deleteBookmark,
    createAutoBookmark,
  } = useReaderBookmarks({
    initialBookmarks,
    remoteBookmarks: remoteProgress?.bookmarks,
    viewRef,
    currentCfi,
    totalProgress,
    markUserProgressChange,
    saveProgressIfChanged,
  });

  const {
    syncConflict,
    dismissSyncConflict,
    acceptSyncConflict,
  } = useRemoteProgressPrompt({
    isLoaded,
    remoteProgress,
    currentCfi,
    totalProgress,
    lastSaveTimeRef,
    goTo,
    getBookmarks,
    createAutoBookmark,
    prepareRemoteJump,
    completeRemoteJump,
  });

  const {
    sliderProgress,
    beginSliderMove,
    previewSliderMove,
    commitSliderMove,
  } = useReaderProgressSlider({
    currentCfi,
    totalProgress,
    createAutoBookmark,
    markUserProgressChange,
    goToFraction,
  });

  useEffect(() => {
    updateSaveContext({
      currentCfi,
      totalProgress,
      bookmarks,
      hasSyncConflict: Boolean(syncConflict),
    });
  }, [bookmarks, currentCfi, syncConflict, totalProgress, updateSaveContext]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        saveCurrentProgress();
      }
    };

    window.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('visibilitychange', handleVisibility);
      saveCurrentProgress();
    };
  }, [saveCurrentProgress]);

  const handleInteraction = useCallback((event: React.MouseEvent) => {
    const { clientX, clientY } = event;
    const width = window.innerWidth;
    const height = window.innerHeight;

    if (settings.navMode === 'page') {
      if (clientY > height * 0.7) { markUserProgressChange(); next(); return; }
      if (clientY < height * 0.3) { markUserProgressChange(); prev(); return; }
    } else if (settings.navMode === 'left-right') {
      if (clientX < width * 0.3) { markUserProgressChange(); prev(); return; }
      if (clientX > width * 0.7) { markUserProgressChange(); next(); return; }
    } else if (settings.navMode === 'all-dir') {
      if (clientY < height * 0.3) { markUserProgressChange(); prev(); return; }
      if (clientY > height * 0.7) { markUserProgressChange(); next(); return; }
      if (clientX < width * 0.3) { markUserProgressChange(); prev(); return; }
      if (clientX > width * 0.7) { markUserProgressChange(); next(); return; }
    }

    chrome.setShowControls((current) => !current);
  }, [chrome, markUserProgressChange, next, prev, settings.navMode]);

  const performJump = useCallback(async (targetCfi: string) => {
    if (!currentCfi || targetCfi === currentCfi) return;

    const updatedBookmarks = createAutoBookmark(currentCfi, totalProgress);
    markUserProgressChange({
      forceNextRelocateSave: true,
      bookmarks: updatedBookmarks,
    });
    await goTo(targetCfi);
  }, [createAutoBookmark, currentCfi, goTo, markUserProgressChange, totalProgress]);

  const performJumpToProgress = useCallback(async (targetCfi: string, expectedPercent?: number) => {
    if (!currentCfi || targetCfi === currentCfi) return;

    const updatedBookmarks = createAutoBookmark(currentCfi, totalProgress);
    markUserProgressChange({
      forceNextRelocateSave: true,
      expectedPercent,
      bookmarks: updatedBookmarks,
    });
    await goTo(targetCfi);
  }, [createAutoBookmark, currentCfi, goTo, markUserProgressChange, totalProgress]);

  const performJumpFraction = useCallback(async (fraction: number) => {
    const targetPct = fraction * 100;
    const updatedBookmarks = Math.abs(targetPct - totalProgress) > 5
      ? createAutoBookmark(currentCfi, totalProgress)
      : undefined;

    markUserProgressChange({
      forceNextRelocateSave: true,
      expectedPercent: targetPct,
      bookmarks: updatedBookmarks,
    });
    await goToFraction(fraction);
  }, [createAutoBookmark, currentCfi, goToFraction, markUserProgressChange, totalProgress]);

  const handleJump = useCallback(() => {
    const trimmed = chrome.jumpInput.trim();
    if (!trimmed) return;

    if (trimmed.startsWith('epubcfi(')) {
      void performJump(trimmed);
    } else {
      const pct = parseFloat(trimmed.replace('%', ''));
      if (!Number.isNaN(pct)) {
        void performJumpFraction(Math.min(100, Math.max(0, pct)) / 100);
      }
    }

    chrome.closeJumpInput();
  }, [chrome, performJump, performJumpFraction]);

  return (
    <div className={`h-screen w-screen ${theme.bg} ${theme.text} transition-colors duration-300 select-none overflow-hidden`}>
      {!isLoaded && (
        <div className={`absolute inset-0 z-[100] flex items-center justify-center ${theme.bg} text-xs font-black uppercase opacity-20 tracking-widest`}>
          Loading...
        </div>
      )}

      <div ref={containerRef} className="w-full h-full" style={{ position: 'relative' }} />

      {isLoaded && settings.navMode !== 'scroll' && (
        <div className="fixed inset-0 z-10" style={{ background: 'transparent' }} onClick={handleInteraction} />
      )}

      <ReaderToolbar
        theme={theme}
        bookName={book.name}
        showControls={chrome.showControls}
        currentChapter={currentChapter}
        totalProgress={totalProgress}
        sliderProgress={sliderProgress}
        bookmarkCount={bookmarks.length}
        onBack={chrome.handleUIBack}
        onOpenJump={chrome.openJumpInput}
        onOpenSearch={() => { chrome.setShowSearchModal(true); chrome.setShowControls(false); }}
        onOpenSettings={() => chrome.setShowSettings(true)}
        onOpenTheme={() => chrome.setShowThemeModal(true)}
        onOpenBookmarks={() => chrome.setShowBookmarks(true)}
        onOpenToc={() => chrome.setShowToc(true)}
        onProgressSliderStart={beginSliderMove}
        onProgressSliderPreview={previewSliderMove}
        onProgressSliderCommit={commitSliderMove}
      />

      {chrome.showSettings && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => chrome.setShowSettings(false)}
          theme={theme}
        />
      )}

      {chrome.showThemeModal && (
        <ThemeModal
          settings={settings}
          onUpdateSettings={onUpdateSettings}
          onClose={() => chrome.setShowThemeModal(false)}
          theme={theme}
          onSelectTheme={(newTheme) => onUpdateSettings({ theme: newTheme })}
        />
      )}

      {chrome.showBookmarks && (
        <BookmarkModal
          bookmarks={bookmarks}
          theme={theme}
          onClose={() => chrome.setShowBookmarks(false)}
          onAdd={addBookmark}
          onDelete={deleteBookmark}
          onJump={(cfi, progressPercent) => { void performJumpToProgress(cfi, progressPercent); chrome.setShowBookmarks(false); }}
        />
      )}

      {chrome.showToc && (
        <TocModal
          toc={toc}
          theme={theme}
          onClose={() => chrome.setShowToc(false)}
          onJump={(href, progressPercent) => { void performJumpToProgress(href, progressPercent); chrome.setShowToc(false); }}
          currentChapter={currentChapter}
        />
      )}

      {chrome.showSearchModal && (
        <EpubSearchModal
          theme={theme}
          onClose={() => chrome.setShowSearchModal(false)}
          onSelect={(cfi, progressPercent) => { void performJumpToProgress(cfi, progressPercent); chrome.setShowSearchModal(false); }}
          onSearch={searchBook}
          onClear={clearSearch}
        />
      )}

      {chrome.showJumpInput && (
        <JumpDialog
          theme={theme}
          value={chrome.jumpInput}
          onChange={chrome.setJumpInput}
          onSubmit={handleJump}
          onClose={chrome.closeJumpInput}
        />
      )}

      {syncConflict && (
        <SyncConflictDialog
          theme={theme}
          syncConflict={syncConflict}
          onDismiss={dismissSyncConflict}
          onAccept={acceptSyncConflict}
        />
      )}
    </div>
  );
};

export default EpubReaderInner;
