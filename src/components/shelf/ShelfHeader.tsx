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
  ArrowDownAZ,
  Clock,
  Palette,
  FilePlus,
  CloudLightning,
  Highlighter,
  BarChart3,
  X
} from 'lucide-react';
import type { CloudSyncStatus } from './FileUploader';

interface ShelfHeaderProps {
  shelfContentRef: React.RefObject<HTMLElement | null>;
  isOfflineMode: boolean;
  isGuest: boolean;
  syncStatus: CloudSyncStatus;
  userEmail: string;
  searchKeyword: string;
  sortMode: 'alpha' | 'recent';
  viewMode: 'grid' | 'list';
  onToggleCloud: () => void;
  onLogin: () => void;
  onLogout: () => void;
  setShowSearch: (show: boolean) => void;
  onToggleSortMode: () => void;
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
  viewMode,
  onToggleCloud,
  onLogin,
  onLogout,
  setShowSearch,
  onToggleSortMode,
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
      const topDockBottom = topDock.getBoundingClientRect().bottom;
      const scrollGate = isBottomDockRef.current ? 24 : 56;
      const hasScrolledIntoShelf = window.scrollY > scrollGate;
      const shouldMoveBottom = isBottomDockRef.current
        ? hasScrolledIntoShelf && contentTop <= topDockBottom + 72
        : hasScrolledIntoShelf && contentTop <= topDockBottom + 12;

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

  const getSortIcon = (iconSize: number) => {
    if (sortMode === 'alpha') return <ArrowDownAZ size={iconSize} />;
    return <Clock size={iconSize} />;
  };

  const getSortTitle = () => {
    if (sortMode === 'alpha') return "가나다순";
    return "최근에 읽은 순";
  };

  const desktopDockIconSize = 24;
  const bottomDockIconSize = 26;
  const mobileHeaderIconSize = 20;
  const brandSurfaceClass = "drop-shadow-[0_10px_24px_rgba(0,0,0,0.34)]";
  const dockSurfaceClass = "border border-[color:var(--viewer-theme-border)] bg-[color:var(--viewer-reader-surface)] text-[color:var(--viewer-theme-text)] backdrop-blur-xl";
  const dockClass = `flex h-[4.125rem] items-center rounded-[1.65rem] ${dockSurfaceClass} px-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)]`;
  const bottomDockClass = `flex h-[4.25rem] w-[calc(100vw-1rem)] max-w-sm items-center justify-center rounded-[1.55rem] ${dockSurfaceClass} px-1 shadow-[0_18px_55px_rgba(0,0,0,0.28)] md:h-[4.5rem] md:w-auto md:max-w-[calc(100vw-1rem)] md:rounded-[1.9rem] md:px-3`;
  const dockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] opacity-70 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const activeDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90";
  const accentDockButtonClass = `${dockButtonClass} text-accent-500`;
  const bottomDockButtonClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[1rem] opacity-75 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90 md:h-14 md:w-14 md:rounded-[1.1rem]";
  const activeBottomDockButtonClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-[1rem] bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90 md:h-14 md:w-14 md:rounded-[1.1rem]";
  const accentBottomDockButtonClass = `${bottomDockButtonClass} text-accent-500`;
  const mobileHeaderButtonClass = "flex size-10 shrink-0 items-center justify-center rounded-xl bg-transparent p-0 opacity-75 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const menuShellStyle: React.CSSProperties = {
    top: 'calc(env(safe-area-inset-top) + 2rem)',
    right: 'max(1.5rem, calc((100vw - 80rem) / 2 + 1.5rem))',
  };

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
        data-shelf-sort-control="true"
        onClick={onToggleSortMode}
        className={buttonClass}
        title={getSortTitle()}
        aria-label={getSortTitle()}
      >
        <div className="relative flex items-center justify-center">
          {getSortIcon(iconSize)}
          <span className="pointer-events-none absolute -bottom-1 -right-1 rounded-sm bg-accent-500 px-0.5 text-[8px] font-bold text-white">
            {sortMode === 'alpha' ? 'A' : 'R'}
          </span>
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
    <div className={`fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.85rem)] z-[80] flex justify-center px-2 pointer-events-none ${isBottomDock ? 'md:flex' : 'md:hidden'}`}>
      <div data-shelf-bottom-dock="true" className={`${bottomDockClass} pointer-events-auto overflow-x-hidden animate-in fade-in slide-in-from-bottom-3 duration-200 ease-out md:overflow-x-auto`}>
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
      <header className="relative z-40 pt-8 pb-6 transition-colors duration-300">
        <div className="max-w-7xl mx-auto flex h-[4.125rem] items-center justify-between px-4 md:px-6">
          <div className={`flex h-full min-w-0 flex-1 items-center gap-3 md:gap-4 ${brandSurfaceClass}`}>
            <button
              onClick={isGuest ? onLogin : onToggleCloud}
              className={`relative shrink-0 rounded-2xl p-3 shadow-lg transition-all active:scale-90 group ${
                isOfflineMode
                  ? 'bg-slate-700 shadow-none hover:bg-slate-600'
                  : 'bg-accent-600 shadow-accent-500/20 hover:bg-accent-500'
              }`}
              title={isGuest ? "Sign in" : isOfflineMode ? "Connect to Cloud" : "Disconnect Cloud"}
            >
              {isGuest ? (
                <KeyRound className="text-white group-hover:text-accent-300 transition-colors" size={24} />
              ) : isOfflineMode ? (
                <WifiOff className="text-white group-hover:text-accent-300 transition-colors" size={24} />
              ) : (
                <Library className="text-white" size={24} />
              )}
            </button>

            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate whitespace-nowrap text-lg font-black uppercase tracking-tight md:text-xl">
                  {isGuest ? 'Guest Library' : (isOfflineMode ? 'Local Library' : 'Cloud Library')}
                </h1>
                {syncStatus && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-500/10 border border-accent-500/20 rounded-xl text-accent-500 animate-in fade-in zoom-in duration-300">
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
              <div className="flex items-center gap-1.5 text-[10px] opacity-60 font-bold uppercase tracking-widest">
                {isGuest && <UserIcon size={10} />}
                <span className="truncate">{userEmail}</span>
              </div>
            </div>
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
            className={`fixed z-50 hidden transition-all duration-200 ease-out md:block ${isBottomDock ? 'pointer-events-none -translate-y-2 opacity-0' : 'translate-y-0 opacity-100'}`}
            ref={mobileMenuRef}
            style={menuShellStyle}
          >
            <div className={`hidden items-center gap-1.5 md:flex ${dockClass}`}>
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
