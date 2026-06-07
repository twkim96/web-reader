// src/components/EpubReader.tsx
'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Book, Bookmark, SaveProgressOptions, UserProgress, ViewerSettings } from '../types';
import { getThemeClasses, getThemeColors, getThemeTextureCss } from '../lib/themeUtils';
import { SettingsModal } from './SettingsModal';
import { ThemeModal } from './ThemeModal';
import { BookmarkModal } from './BookmarkModal';
import { TocModal } from './TocModal';
import { EpubSearchModal } from './EpubSearchModal';
import { JumpDialog } from './reader/JumpDialog';
import { ProgressJumpConfirmDialog } from './reader/ProgressJumpConfirmDialog';
import { ReaderStatusBar } from './reader/ReaderStatusBar';
import { ReaderToolbar } from './reader/ReaderToolbar';
import { SyncConflictDialog } from './reader/SyncConflictDialog';
import { useEpubReader } from '../hooks/useEpubReader';
import { useReaderBookSource } from '../hooks/reader/useReaderBookSource';
import { useReaderBookmarks } from '../hooks/reader/useReaderBookmarks';
import { useReaderChrome } from '../hooks/reader/useReaderChrome';
import { useReaderProgressSave } from '../hooks/reader/useReaderProgressSave';
import { useReaderProgressSlider } from '../hooks/reader/useReaderProgressSlider';
import { useRemoteProgressPrompt } from '../hooks/reader/useRemoteProgressPrompt';
import type { TocItem } from '../hooks/foliate/types';

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

const KEYBOARD_SCROLL_RATIO = 0.25;
const MIN_KEYBOARD_SCROLL_DISTANCE = 80;
const MAX_KEYBOARD_SCROLL_DISTANCE = 240;
const WHEEL_PAGE_TURN_MIN_DELTA = 8;
const WHEEL_PAGE_TURN_IDLE_MS = 220;

const isEditableKeyboardTarget = (target: EventTarget | null) => {
  const node = target as {
    nodeType?: number;
    tagName?: string;
    isContentEditable?: boolean;
    parentElement?: HTMLElement | null;
  } | null;
  if (!node) return false;

  const element = node.nodeType === 1 ? node : node.parentElement;
  const tagName = element?.tagName?.toLowerCase();
  return Boolean(element?.isContentEditable) || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
};

const flattenTocItems = (items: TocItem[]): TocItem[] => (
  items.flatMap((item) => [item, ...flattenTocItems(item.subitems || [])])
);

const getChapterForProgress = (items: TocItem[], progressPercent: number) => {
  if (!Number.isFinite(progressPercent)) return undefined;

  const chapters = flattenTocItems(items)
    .filter((item): item is TocItem & { label: string; progress: number } => (
      Boolean(item.label) && Number.isFinite(item.progress)
    ))
    .sort((a, b) => a.progress - b.progress);

  if (chapters.length === 0) return undefined;

  let match: string | undefined;
  for (const chapter of chapters) {
    if (chapter.progress <= progressPercent + 0.05) {
      match = chapter.label;
      continue;
    }
    break;
  }

  return match;
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
  const theme = getThemeClasses(settings);
  const themeColors = useMemo(() => getThemeColors(settings), [settings]);
  const themeTexture = useMemo(() => getThemeTextureCss(settings), [settings]);
  const readerEdgePadding = Math.max(settings.padding || 0, settings.fontSize);
  const keyboardNavigationRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const wheelNavigationRef = useRef<(event: WheelEvent | React.WheelEvent) => void>(() => undefined);
  const wheelNavigationCycleLockedRef = useRef(false);
  const wheelNavigationResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    doc.addEventListener('wheel', (event) => wheelNavigationRef.current(event), { passive: false });
    doc.addEventListener('touchmove', () => markUserProgressChange(), { passive: true });
    doc.addEventListener('keydown', (event) => keyboardNavigationRef.current(event));
  }, [chrome.toggleControls, markUserProgressChange]);

  const {
    containerRef,
    totalProgress,
    currentCfi,
    currentAnchorCfi,
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
    themeTexture,
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
    currentAnchorCfi,
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
    isSliderPreviewing,
    pendingSliderMove,
    beginSliderMove,
    previewSliderMove,
    commitSliderMove,
    cancelSliderMove,
    confirmSliderMove,
  } = useReaderProgressSlider({
    currentCfi,
    totalProgress,
    createAutoBookmark,
    markUserProgressChange,
    goToFraction,
  });

  const sliderTargetChapter = useMemo(
    () => getChapterForProgress(toc, sliderProgress),
    [sliderProgress, toc]
  );
  const pendingSliderTargetChapter = useMemo(
    () => pendingSliderMove ? getChapterForProgress(toc, pendingSliderMove.targetPercent) : undefined,
    [pendingSliderMove, toc]
  );

  useEffect(() => {
    updateSaveContext({
      currentCfi,
      currentAnchorCfi,
      totalProgress,
      bookmarks,
      hasSyncConflict: Boolean(syncConflict),
    });
  }, [bookmarks, currentAnchorCfi, currentCfi, syncConflict, totalProgress, updateSaveContext]);

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
      if (clientY > height * 0.67) { markUserProgressChange(); next(); return; }
      if (clientY < height * 0.33) { markUserProgressChange(); prev(); return; }
    } else if (settings.navMode === 'left-right') {
      if (clientX < width * 0.3) { markUserProgressChange(); prev(); return; }
      if (clientX > width * 0.7) { markUserProgressChange(); next(); return; }
    } else if (settings.navMode === 'all-dir') {
      if (clientY < height * 0.33) { markUserProgressChange(); prev(); return; }
      if (clientY > height * 0.67) { markUserProgressChange(); next(); return; }
      if (clientX < width * 0.3) { markUserProgressChange(); prev(); return; }
      if (clientX > width * 0.7) { markUserProgressChange(); next(); return; }
    }

    chrome.setShowControls((current) => !current);
  }, [chrome, markUserProgressChange, next, prev, settings.navMode]);

  useEffect(() => {
    return () => {
      if (wheelNavigationResetTimerRef.current) {
        clearTimeout(wheelNavigationResetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const unlockWheelNavigationAfterIdle = () => {
      if (wheelNavigationResetTimerRef.current) {
        clearTimeout(wheelNavigationResetTimerRef.current);
      }

      wheelNavigationResetTimerRef.current = setTimeout(() => {
        wheelNavigationCycleLockedRef.current = false;
        wheelNavigationResetTimerRef.current = null;
      }, WHEEL_PAGE_TURN_IDLE_MS);
    };

    const handleWheelNavigation = (event: WheelEvent | React.WheelEvent) => {
      if (settings.navMode === 'scroll') {
        markUserProgressChange();
        return;
      }

      if (isEditableKeyboardTarget(event.target)) return;

      const isReaderPanelOpen = chrome.showControls
        || chrome.showSettings
        || chrome.showThemeModal
        || chrome.showBookmarks
        || chrome.showToc
        || chrome.showSearchModal
        || chrome.showJumpInput;
      if (isReaderPanelOpen) return;

      const absDeltaX = Math.abs(event.deltaX);
      const absDeltaY = Math.abs(event.deltaY);
      if (absDeltaX < WHEEL_PAGE_TURN_MIN_DELTA && absDeltaY < WHEEL_PAGE_TURN_MIN_DELTA) return;

      event.preventDefault();
      event.stopPropagation();
      unlockWheelNavigationAfterIdle();

      if (wheelNavigationCycleLockedRef.current) return;
      wheelNavigationCycleLockedRef.current = true;

      const dominantDelta = absDeltaX > absDeltaY ? event.deltaX : event.deltaY;
      markUserProgressChange();
      if (dominantDelta < 0) prev();
      else next();
    };

    wheelNavigationRef.current = handleWheelNavigation;
    return () => {
      if (wheelNavigationRef.current === handleWheelNavigation) {
        wheelNavigationRef.current = () => undefined;
      }
    };
  }, [
    chrome.showBookmarks,
    chrome.showControls,
    chrome.showJumpInput,
    chrome.showSearchModal,
    chrome.showSettings,
    chrome.showThemeModal,
    chrome.showToc,
    markUserProgressChange,
    next,
    prev,
    settings.navMode,
  ]);

  useEffect(() => {
    if (!isLoaded) return;

    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isEditableKeyboardTarget(event.target)) return;

      const isReaderPanelOpen = chrome.showSettings
        || chrome.showThemeModal
        || chrome.showBookmarks
        || chrome.showToc
        || chrome.showSearchModal
        || chrome.showJumpInput;
      if (isReaderPanelOpen) return;

      if (settings.navMode === 'scroll') {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

        event.preventDefault();
        const viewportSize = viewRef.current?.renderer?.size ?? window.innerHeight;
        const scrollDistance = Math.min(
          MAX_KEYBOARD_SCROLL_DISTANCE,
          Math.max(MIN_KEYBOARD_SCROLL_DISTANCE, Math.round(viewportSize * KEYBOARD_SCROLL_RATIO))
        );

        markUserProgressChange();
        if (event.key === 'ArrowUp') prev(scrollDistance);
        else next(scrollDistance);
        return;
      }

      const keyMovesPrev = (settings.navMode === 'page' && event.key === 'ArrowUp')
        || (settings.navMode === 'left-right' && event.key === 'ArrowLeft')
        || (settings.navMode === 'all-dir' && (event.key === 'ArrowUp' || event.key === 'ArrowLeft'));
      const keyMovesNext = (settings.navMode === 'page' && event.key === 'ArrowDown')
        || (settings.navMode === 'left-right' && event.key === 'ArrowRight')
        || (settings.navMode === 'all-dir' && (event.key === 'ArrowDown' || event.key === 'ArrowRight'));

      if (!keyMovesPrev && !keyMovesNext) return;

      event.preventDefault();
      if (event.repeat) return;

      markUserProgressChange();
      if (keyMovesPrev) prev();
      else next();
    };

    keyboardNavigationRef.current = handleKeyboardNavigation;
    window.addEventListener('keydown', handleKeyboardNavigation);
    return () => {
      window.removeEventListener('keydown', handleKeyboardNavigation);
      if (keyboardNavigationRef.current === handleKeyboardNavigation) {
        keyboardNavigationRef.current = () => undefined;
      }
    };
  }, [
    chrome.showBookmarks,
    chrome.showJumpInput,
    chrome.showSearchModal,
    chrome.showSettings,
    chrome.showThemeModal,
    chrome.showToc,
    isLoaded,
    markUserProgressChange,
    next,
    prev,
    settings.navMode,
    viewRef,
  ]);

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

      <div
        ref={containerRef}
        className="w-full h-full"
        style={{
          boxSizing: 'border-box',
          paddingBlock: `${readerEdgePadding}px`,
          position: 'relative',
        }}
      />

      {isLoaded && settings.navMode !== 'scroll' && (
        <div
          className="fixed inset-0 z-10"
          style={{ background: 'transparent' }}
          onClick={handleInteraction}
          onWheel={(event) => wheelNavigationRef.current(event)}
        />
      )}

      {chrome.showControls && (
        <div
          className="fixed inset-0 z-40 touch-none"
          style={{ background: 'transparent' }}
          onClick={() => chrome.setShowControls(false)}
          onWheel={(e) => { e.stopPropagation(); }}
        />
      )}

      {isLoaded && (
        <ReaderStatusBar
          theme={theme}
          currentChapter={currentChapter}
          totalProgress={totalProgress}
          onOpenJump={chrome.openJumpInput}
        />
      )}

      <ReaderToolbar
        theme={theme}
        bookName={book.name}
        showControls={chrome.showControls}
        sliderProgress={sliderProgress}
        isSliderPreviewing={isSliderPreviewing}
        sliderPreviewChapter={sliderTargetChapter}
        bookmarkCount={bookmarks.length}
        onBack={chrome.handleUIBack}
        onOpenSearch={() => chrome.setShowSearchModal(true)}
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

      {pendingSliderMove && (
        <ProgressJumpConfirmDialog
          theme={theme}
          targetPercent={pendingSliderMove.targetPercent}
          targetChapter={pendingSliderTargetChapter}
          onCancel={cancelSliderMove}
          onConfirm={() => { void confirmSliderMove(); }}
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
