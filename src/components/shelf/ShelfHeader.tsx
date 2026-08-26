import React, { useState, useRef, useEffect } from 'react';
import { 
  Library, 
  Search, 
  LogOut,
  KeyRound,
  HardDrive,
  WifiOff,
  User as UserIcon,
  LayoutGrid,
  List,
  SlidersHorizontal,
  Palette,
  FilePlus,
  CloudLightning,
  Highlighter,
  BarChart3,
  X
} from 'lucide-react';
import type { CloudSyncStatus } from './FileUploader';
import type { ShelfSortMode } from './bookUtils';
import type { ShelfDockStyle } from '../../types';

interface ShelfHeaderProps {
  shelfContentRef: React.RefObject<HTMLElement | null>;
  isOfflineMode: boolean;
  isGuest: boolean;
  syncStatus: CloudSyncStatus;
  userEmail: string;
  searchKeyword: string;
  sortMode: ShelfSortMode;
  activeFilterCount: number;
  viewMode: 'grid' | 'list';
  dockStyle: ShelfDockStyle;
  onToggleCloud: () => void;
  onLogin: () => void;
  onLogout: () => void;
  setShowSearch: (show: boolean) => void;
  onShowFilters: () => void;
  onToggleViewMode: () => void;
  setShowThemeModal: (show: boolean) => void;
  setShowManage: (show: boolean) => void;
  setShowImportConfirm: (show: boolean) => void;
  onShowAnnotations: () => void;
  onShowStatistics: () => void;
  onCancelSync: () => void;
}

export const ShelfHeader: React.FC<ShelfHeaderProps> = ({
  shelfContentRef,
  isOfflineMode,
  isGuest,
  syncStatus,
  userEmail,
  searchKeyword,
  sortMode,
  activeFilterCount,
  viewMode,
  dockStyle,
  onToggleCloud,
  onLogin,
  onLogout,
  setShowSearch,
  onShowFilters,
  onToggleViewMode,
  setShowThemeModal,
  setShowManage,
  setShowImportConfirm,
  onShowAnnotations,
  onShowStatistics,
  onCancelSync
}) => {
  const [isBottomDock, setIsBottomDock] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const isBottomDockRef = useRef(false);

  useEffect(() => {
    let frameId = 0;

    const measureDockMode = () => {
      frameId = 0;
      const content = shelfContentRef.current;
      const topDock = mobileMenuRef.current;
      if (!content || !topDock) return;

      const contentTop = content.getBoundingClientRect().top;
      const restingTopDockBottom = topDock.getBoundingClientRect().bottom + window.scrollY;
      const scrollGate = isBottomDockRef.current ? 24 : 56;
      const hasScrolledIntoShelf = window.scrollY > scrollGate;
      const shouldMoveBottom = isBottomDockRef.current
        ? hasScrolledIntoShelf && contentTop <= restingTopDockBottom + 72
        : hasScrolledIntoShelf && contentTop <= restingTopDockBottom + 12;

      if (shouldMoveBottom !== isBottomDockRef.current) {
        isBottomDockRef.current = shouldMoveBottom;
        setIsBottomDock(shouldMoveBottom);
      }
    };

    const scheduleMeasure = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(measureDockMode);
    };

    scheduleMeasure();
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure);
    return () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [shelfContentRef]);

  const sortLabel = sortMode === 'alpha'
    ? '가나다순'
    : sortMode === 'popularity'
      ? '통합 인기순'
      : '최근에 읽은 순';
  const filterActive = sortMode !== 'recent' || activeFilterCount > 0;
  const filterTitle = `책장 정렬·필터: ${sortLabel}${
    activeFilterCount > 0 ? `, 필터 ${activeFilterCount}개` : ''
  }`;

  const desktopDockIconSize = 22;
  const bottomDockIconSize = 26;
  const mobileHeaderIconSize = 20;
  const modernDock = dockStyle === 'modern';
  const standardDock = dockStyle === 'standard';
  const dockSurfaceClass = modernDock
    ? "shelf-muzio-dock text-[color:var(--viewer-theme-text)]"
    : standardDock
      ? "border border-[color:var(--viewer-theme-border)] bg-[color:var(--viewer-reader-surface)] text-[color:var(--viewer-theme-text)] backdrop-blur-xl"
      : "viewer-cime-glass border text-[color:var(--viewer-theme-text)]";
  const dockClass = `relative flex h-[4.125rem] items-center rounded-[20px] ${dockSurfaceClass} gap-0.5 px-1.5 ${standardDock ? 'shadow-[0_18px_55px_rgba(0,0,0,0.18)]' : ''} lg:gap-1.5 lg:px-2`;
  const bottomDockClass = `relative flex h-[4.25rem] w-[calc(100vw-1rem)] max-w-sm items-center justify-center rounded-[34px] md:rounded-[20px] ${standardDock ? 'shadow-[0_18px_55px_rgba(0,0,0,0.28)]' : ''} ${dockSurfaceClass} px-1 md:h-[4.5rem] md:w-auto md:max-w-[calc(100vw-1rem)] md:px-3`;
  const dockButtonClass = "flex h-11 w-11 items-center justify-center rounded-full opacity-[0.84] transition-all hover:bg-current/10 hover:opacity-100 active:scale-90 lg:h-12 lg:w-12";
  const activeDockButtonClass = "flex h-11 w-11 items-center justify-center rounded-full bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90 lg:h-12 lg:w-12";
  const accentDockButtonClass = `${dockButtonClass} text-accent-500`;
  const bottomDockButtonClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-[0.84] transition-[transform,opacity,background-color] duration-150 hover:bg-current/10 hover:opacity-100 active:scale-90 md:h-14 md:w-14";
  const activeBottomDockButtonClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white opacity-100 shadow-[0_5px_16px_rgba(0,0,0,0.18)] transition-[transform,background-color] duration-150 active:scale-90 md:h-14 md:w-14";
  const accentBottomDockButtonClass = `${bottomDockButtonClass} text-accent-500`;
  const mobileHeaderButtonClass = "flex size-10 shrink-0 items-center justify-center rounded-xl bg-transparent p-0 opacity-75 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const renderLayoutControls = ({
    iconSize,
    buttonClass,
  }: {
    iconSize: number;
    buttonClass: string;
  }) => (
    <>
      <button
        type="button"
        data-shelf-filter-control="true"
        onClick={onShowFilters}
        className={`${buttonClass} ${filterActive ? 'text-accent-500 opacity-100' : ''}`}
        title={filterTitle}
        aria-label={filterTitle}
      >
        <div className="relative flex items-center justify-center">
          <SlidersHorizontal size={iconSize} />
          {activeFilterCount > 0 && (
            <span className="pointer-events-none absolute -bottom-1.5 -right-2 min-w-3.5 rounded-full bg-accent-500 px-1 text-center text-[8px] font-bold leading-3.5 text-white">
              {activeFilterCount > 9 ? '9+' : activeFilterCount}
            </span>
          )}
        </div>
      </button>

      <button
        type="button"
        data-shelf-view-control="true"
        onClick={onToggleViewMode}
        className={buttonClass}
        title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
        aria-label={viewMode === 'grid' ? "목록 보기" : "그리드 보기"}
      >
        {viewMode === 'grid' ? <List size={iconSize} /> : <LayoutGrid size={iconSize} />}
      </button>
    </>
  );

  const renderDockActions = ({
    iconSize,
    buttonClass,
    activeButtonClass,
    accentButtonClass,
    includeAuth = false,
    includeLayoutControls = true,
    layoutControlsClassName = '',
  }: {
    iconSize: number;
    buttonClass: string;
    activeButtonClass: string;
    accentButtonClass: string;
    includeAuth?: boolean;
    includeLayoutControls?: boolean;
    layoutControlsClassName?: string;
  }) => {
    const runAction = (action: () => void) => {
      action();
    };

    return (
      <>
        <button
          onClick={() => runAction(() => setShowSearch(true))}
          className={searchKeyword ? activeButtonClass : buttonClass}
          title="Search Books"
        >
          <Search size={iconSize} />
        </button>

        <button
          onClick={() => runAction(onShowAnnotations)}
          className={buttonClass}
          title="라이브러리 전체 주석"
          aria-label="라이브러리 전체 주석"
        >
          <Highlighter size={iconSize} />
        </button>

        <button
          onClick={() => runAction(onShowStatistics)}
          className={buttonClass}
          title="독서 통계"
          aria-label="독서 통계"
        >
          <BarChart3 size={iconSize} />
        </button>

        <button
          onClick={() => runAction(() => setShowImportConfirm(true))}
          className={accentButtonClass}
          title="Add Local Book"
        >
          <FilePlus size={iconSize} />
        </button>

        {includeLayoutControls && renderLayoutControls({
          iconSize,
          buttonClass: `${buttonClass} ${layoutControlsClassName}`,
        })}

        <button
          onClick={() => runAction(() => setShowThemeModal(true))}
          className={buttonClass}
          title="Change Theme"
        >
          <Palette size={iconSize} />
        </button>

        <button
          onClick={() => runAction(() => setShowManage(true))}
          className={buttonClass}
          title="Manage Offline Books"
        >
          <HardDrive size={iconSize} />
        </button>

        {includeAuth && (
          <button
            type="button"
            data-shelf-auth-control="true"
            onClick={() => runAction(isGuest ? onLogin : onLogout)}
            className={isGuest ? accentButtonClass : `${buttonClass} text-red-400`}
            title={isGuest ? "Sign In" : "Sign Out"}
            aria-label={isGuest ? "Sign In" : "Sign Out"}
          >
            {isGuest ? <KeyRound size={iconSize} /> : <LogOut size={iconSize} />}
          </button>
        )}
      </>
    );
  };

  const bottomDock = (
    <div className={`fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-[80] flex justify-center px-2 pointer-events-none md:bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] ${isBottomDock ? 'md:flex' : 'md:hidden'}`}>
      <div data-shelf-bottom-dock="true" data-shelf-dock-style={dockStyle} className={`${bottomDockClass} pointer-events-auto overflow-x-hidden animate-in fade-in slide-in-from-bottom-3 duration-200 ease-out md:overflow-x-auto`}>
        <div className="flex w-full min-w-0 items-center justify-evenly gap-0.5 md:w-auto md:min-w-max md:justify-start md:gap-2">
          {renderDockActions({
            iconSize: bottomDockIconSize,
            buttonClass: bottomDockButtonClass,
            activeButtonClass: activeBottomDockButtonClass,
            accentButtonClass: accentBottomDockButtonClass,
            layoutControlsClassName: 'hidden md:flex',
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <header className="relative z-40 pt-[calc(env(safe-area-inset-top)+2rem)] pb-6 transition-colors duration-300">
        <div className="max-w-7xl mx-auto flex h-[4.125rem] items-center justify-between px-4 md:px-6">
          <div className="flex h-full min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              data-shelf-brand-control="true"
              onClick={isGuest ? onLogin : onToggleCloud}
              className="group flex h-full min-w-0 items-center gap-2.5 text-left text-[color:var(--viewer-theme-text)] transition-opacity active:opacity-70"
              title={isGuest ? "Sign in" : isOfflineMode ? "Connect to Cloud" : "Disconnect Cloud"}
              aria-label={isGuest ? "Sign in" : isOfflineMode ? "Connect to Cloud" : "Disconnect Cloud"}
            >
              <span className="flex size-9 shrink-0 items-center justify-center text-accent-500 opacity-90 transition-opacity group-hover:opacity-100">
                {isGuest ? (
                  <KeyRound size={28} />
                ) : isOfflineMode ? (
                  <WifiOff size={28} />
                ) : (
                  <Library size={28} />
                )}
              </span>
              <span className="min-w-0">
                <span
                  role="heading"
                  aria-level={1}
                  data-shelf-library-label="true"
                  className="block truncate whitespace-nowrap text-lg font-normal tracking-tight md:text-xl"
                >
                  {isGuest ? 'Guest Library' : (isOfflineMode ? 'Local Library' : 'Cloud Library')}
                </span>
                <span className="flex items-center gap-1.5 text-[10px] font-normal tracking-wide opacity-55">
                  {isGuest && <UserIcon size={10} />}
                  <span className="truncate">{userEmail}</span>
                </span>
              </span>
            </button>

            {syncStatus && (
              <div className="flex shrink-0 items-center gap-1.5 px-3 py-1.5 bg-accent-500/10 border border-accent-500/20 rounded-xl text-accent-500 animate-in fade-in zoom-in duration-300">
                <CloudLightning size={14} className="animate-bounce" />
                <span className="text-[10px] font-black uppercase tracking-[0.1em]">
                  {syncStatus.retryCount > 0 ? `재시도 ${syncStatus.retryCount}` : `${syncStatus.progressPercent}%`}
                </span>
                <button
                  type="button"
                  onClick={onCancelSync}
                  className="rounded p-0.5 hover:bg-accent-500/10"
                  title="클라우드 업로드 취소"
                  aria-label="클라우드 업로드 취소"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="ml-1 flex shrink-0 items-center md:hidden">
            <button
              type="button"
              data-shelf-auth-control="true"
              onClick={isGuest ? onLogin : onLogout}
              className={`${mobileHeaderButtonClass} ${isGuest ? 'text-accent-500' : 'text-red-400'}`}
              title={isGuest ? "Sign In" : "Sign Out"}
              aria-label={isGuest ? "Sign In" : "Sign Out"}
            >
              {isGuest
                ? <KeyRound size={mobileHeaderIconSize} />
                : <LogOut size={mobileHeaderIconSize} />}
            </button>
          </div>

          <div
            className={`relative -top-[0.5625rem] ml-3 hidden shrink-0 self-center transition-all duration-200 ease-out md:block ${isBottomDock ? 'pointer-events-none -translate-y-2 opacity-0' : 'translate-y-0 opacity-100'}`}
            ref={mobileMenuRef}
          >
            <div data-shelf-top-dock="true" data-shelf-dock-style={dockStyle} className={`hidden items-center md:flex ${dockClass}`}>
              {renderDockActions({
                iconSize: desktopDockIconSize,
                buttonClass: dockButtonClass,
                activeButtonClass: activeDockButtonClass,
                accentButtonClass: accentDockButtonClass,
                includeAuth: true,
              })}
            </div>
          </div>
      </div>
      </header>
      <div
        data-shelf-mobile-layout-controls="true"
        className="relative z-40 mx-auto -mt-4 flex max-w-7xl justify-end gap-1 px-6 pb-1 md:hidden"
      >
        {renderLayoutControls({
          iconSize: mobileHeaderIconSize,
          buttonClass: mobileHeaderButtonClass,
        })}
      </div>
      {bottomDock}
    </>
  );
};
