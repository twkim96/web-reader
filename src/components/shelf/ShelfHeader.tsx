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
  CloudLightning
} from 'lucide-react';

interface ShelfHeaderProps {
  shelfContentRef: React.RefObject<HTMLElement | null>;
  isOfflineMode: boolean;
  isGuest: boolean;
  isSyncing: boolean;
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
}

export const ShelfHeader: React.FC<ShelfHeaderProps> = ({
  shelfContentRef,
  isOfflineMode,
  isGuest,
  isSyncing,
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
  setShowImportConfirm
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
  const authIconSize = 28;
  const brandSurfaceClass = "drop-shadow-[0_10px_24px_rgba(0,0,0,0.34)]";
  const dockSurfaceClass = "border border-[color:var(--viewer-theme-border)] bg-[color:var(--viewer-reader-surface)] text-[color:var(--viewer-theme-text)] backdrop-blur-xl";
  const dockClass = `flex h-[4.125rem] items-center rounded-[1.65rem] ${dockSurfaceClass} px-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)]`;
  const bottomDockClass = `flex h-[4.25rem] max-w-[calc(100vw-1rem)] items-center justify-center rounded-[1.55rem] ${dockSurfaceClass} px-1.5 shadow-[0_18px_55px_rgba(0,0,0,0.28)] md:h-[4.5rem] md:rounded-[1.9rem] md:px-3`;
  const dockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] opacity-70 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const activeDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90";
  const accentDockButtonClass = `${dockButtonClass} text-accent-500`;
  const bottomDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[1rem] opacity-75 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90 md:h-14 md:w-14 md:rounded-[1.1rem]";
  const activeBottomDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[1rem] bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90 md:h-14 md:w-14 md:rounded-[1.1rem]";
  const accentBottomDockButtonClass = `${bottomDockButtonClass} text-accent-500`;
  const authButtonClass = "fixed z-[85] flex h-[4.125rem] w-12 items-center justify-center bg-transparent p-0 drop-shadow-[0_12px_22px_rgba(0,0,0,0.35)] transition-all hover:opacity-100 active:scale-90";
  const authDangerClass = `${authButtonClass} text-red-400`;
  const authAccentClass = `${authButtonClass} text-accent-500`;
  const menuShellStyle: React.CSSProperties = {
    top: 'calc(env(safe-area-inset-top) + 2rem)',
    right: 'max(5.5rem, calc((100vw - 80rem) / 2 + 5.5rem))',
  };
  const authButtonStyle: React.CSSProperties = {
    top: 'calc(env(safe-area-inset-top) + 2rem)',
    right: 'max(1.5rem, calc((100vw - 80rem) / 2 + 1.5rem))',
  };

  const renderDockActions = ({
    iconSize,
    buttonClass,
    activeButtonClass,
    accentButtonClass,
  }: {
    iconSize: number;
    buttonClass: string;
    activeButtonClass: string;
    accentButtonClass: string;
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
          onClick={() => runAction(() => setShowImportConfirm(true))}
          className={accentButtonClass}
          title="Add Local Book"
        >
          <FilePlus size={iconSize} />
        </button>

        <button
          onClick={() => runAction(onToggleSortMode)}
          className={buttonClass}
          title={getSortTitle()}
        >
          <div className="flex items-center justify-center relative">
            {getSortIcon(iconSize)}
            <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-accent-500 text-white rounded-sm px-0.5 pointer-events-none">
              {sortMode === 'alpha' ? 'A' : 'R'}
            </span>
          </div>
        </button>

        <button
          onClick={() => runAction(onToggleViewMode)}
          className={buttonClass}
          title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
        >
          {viewMode === 'grid' ? <List size={iconSize} /> : <LayoutGrid size={iconSize} />}
        </button>

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
      </>
    );
  };

  const bottomDock = (
    <div className={`fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.85rem)] z-[80] flex justify-center px-2 pointer-events-none ${isBottomDock ? 'md:flex' : 'md:hidden'}`}>
      <div className={`${bottomDockClass} pointer-events-auto animate-in fade-in slide-in-from-bottom-3 duration-200 ease-out`}>
        <div className="flex items-center gap-0.5 md:gap-2">
          {renderDockActions({
            iconSize: bottomDockIconSize,
            buttonClass: bottomDockButtonClass,
            activeButtonClass: activeBottomDockButtonClass,
            accentButtonClass: accentBottomDockButtonClass,
          })}
        </div>
      </div>
    </div>
  );

  return (
    <>
      <header className="relative z-40 pt-8 pb-6 transition-colors duration-300">
        <div className="max-w-7xl mx-auto flex h-[4.125rem] items-center justify-between px-6">
          <div className={`flex h-full items-center gap-4 ${brandSurfaceClass}`}>
            <button
              onClick={isGuest ? onLogin : onToggleCloud}
              className={`p-3 rounded-2xl shadow-lg transition-all active:scale-90 group relative ${
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

            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg md:text-xl font-black tracking-tight uppercase whitespace-nowrap">
                  {isGuest ? 'Guest Library' : (isOfflineMode ? 'Local Library' : 'Cloud Library')}
                </h1>
                {isSyncing && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-accent-500/10 border border-accent-500/20 rounded-xl text-accent-500 animate-in fade-in zoom-in duration-300">
                    <CloudLightning size={14} className="animate-bounce" />
                    <span className="text-[10px] font-black uppercase tracking-[0.1em] hidden sm:inline">Syncing to Cloud</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-[10px] opacity-60 font-bold uppercase tracking-widest">
                {isGuest && <UserIcon size={10} />}
                <span>{userEmail}</span>
              </div>
            </div>
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
              })}
            </div>
          </div>
      </div>
      </header>
      <button
        onClick={isGuest ? onLogin : onLogout}
        className={isGuest ? authAccentClass : authDangerClass}
        style={authButtonStyle}
        title={isGuest ? "Sign In" : "Sign Out"}
        aria-label={isGuest ? "Sign In" : "Sign Out"}
      >
        {isGuest ? <KeyRound size={authIconSize} /> : <LogOut size={authIconSize} />}
      </button>
      {bottomDock}
    </>
  );
};
