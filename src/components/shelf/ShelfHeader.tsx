import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
  Menu,
  X,
  FilePlus,
  CloudLightning
} from 'lucide-react';
import { ThemeClasses } from '../../types';

interface ShelfHeaderProps {
  theme: ThemeClasses;
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
  theme,
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
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuDockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMobileMenu) return;
    const handleOutsidePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (mobileMenuRef.current?.contains(target) || mobileMenuDockRef.current?.contains(target)) return;
      setShowMobileMenu(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown);
  }, [showMobileMenu]);

  const getSortIcon = (iconSize: number) => {
    if (sortMode === 'alpha') return <ArrowDownAZ size={iconSize} />;
    return <Clock size={iconSize} />;
  };

  const getSortTitle = () => {
    if (sortMode === 'alpha') return "가나다순";
    return "최근에 읽은 순";
  };

  const desktopDockIconSize = 24;
  const mobileDockIconSize = 28;
  const mobileHeaderIconSize = 27;
  const brandSurfaceClass = "drop-shadow-[0_10px_24px_rgba(0,0,0,0.34)]";
  const dockClass = `rounded-[1.65rem] border ${theme.border} ${theme.secondary} p-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)] backdrop-blur-xl`;
  const mobileSideDockClass = `rounded-[1.9rem] border ${theme.border} ${theme.secondary} px-3 py-4 shadow-[0_18px_55px_rgba(0,0,0,0.22)] backdrop-blur-xl`;
  const dockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] opacity-65 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const activeDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90";
  const accentDockButtonClass = `${dockButtonClass} text-accent-500`;
  const dangerDockButtonClass = "flex h-12 w-12 items-center justify-center rounded-[0.95rem] text-red-400 opacity-80 transition-all hover:opacity-100 active:scale-90";
  const mobileSideDockButtonClass = "flex h-16 w-16 items-center justify-center rounded-[1.15rem] opacity-65 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const mobileSideAccentButtonClass = `${mobileSideDockButtonClass} text-accent-500`;
  const mobileSideDangerButtonClass = "flex h-16 w-16 items-center justify-center rounded-[1.15rem] text-red-400 opacity-80 transition-all hover:opacity-100 active:scale-90";
  const mobileHeaderDockClass = `flex h-16 items-center gap-1 rounded-[1.35rem] border ${theme.border} ${theme.secondary} px-2 opacity-90 shadow-[0_12px_34px_rgba(0,0,0,0.22)] backdrop-blur-xl`;
  const mobileSearchButtonClass = "flex h-full w-12 items-center justify-center opacity-55 transition-opacity hover:opacity-100 active:scale-90";
  const mobileMenuButtonClass = "flex h-14 w-14 items-center justify-center rounded-[1.05rem] opacity-85 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";

  const mobileDock = showMobileMenu ? (
    <div
      ref={mobileMenuDockRef}
      className="fixed right-[calc(env(safe-area-inset-right)+1rem)] top-1/2 z-[80] -translate-y-1/2 md:hidden"
    >
      <div className={`flex flex-col gap-2.5 ${mobileSideDockClass} animate-in fade-in slide-in-from-right-4 duration-200`}>
        <button
          onClick={() => { setShowMobileMenu(false); setShowImportConfirm(true); }}
          className={mobileSideAccentButtonClass}
          title="Add Local Book"
        >
          <FilePlus size={mobileDockIconSize} />
        </button>

        <button
          onClick={() => { setShowMobileMenu(false); onToggleSortMode(); }}
          className={mobileSideDockButtonClass}
          title={getSortTitle()}
        >
          <div className="flex items-center justify-center relative">
            {getSortIcon(mobileDockIconSize)}
            <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-accent-500 text-white rounded-sm px-0.5 pointer-events-none">
              {sortMode === 'alpha' ? 'A' : 'R'}
            </span>
          </div>
        </button>

        <button
          onClick={() => { setShowMobileMenu(false); onToggleViewMode(); }}
          className={mobileSideDockButtonClass}
          title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
        >
          {viewMode === 'grid' ? <List size={mobileDockIconSize} /> : <LayoutGrid size={mobileDockIconSize} />}
        </button>

        <button
          onClick={() => { setShowMobileMenu(false); setShowThemeModal(true); }}
          className={mobileSideDockButtonClass}
          title="Change Theme"
        >
          <Palette size={mobileDockIconSize} />
        </button>

        <button
          onClick={() => { setShowMobileMenu(false); setShowManage(true); }}
          className={mobileSideDockButtonClass}
          title="Manage Offline Books"
        >
          <HardDrive size={mobileDockIconSize} />
        </button>

        {isGuest ? (
          <button
            onClick={() => { setShowMobileMenu(false); onLogin(); }}
            className={mobileSideAccentButtonClass}
            title="Sign In"
          >
            <KeyRound size={mobileDockIconSize} />
          </button>
        ) : (
          <button
            onClick={() => { setShowMobileMenu(false); onLogout(); }}
            className={mobileSideDangerButtonClass}
            title="Sign Out"
          >
            <LogOut size={mobileDockIconSize} />
          </button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <header className="sticky top-0 z-40 px-6 py-6 transition-colors duration-300">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className={`flex items-center gap-4 ${brandSurfaceClass}`}>
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

          <div className="relative" ref={mobileMenuRef}>
            <div className={`hidden items-center gap-1.5 md:flex ${dockClass}`}>
              <button
                onClick={() => setShowSearch(true)}
                className={searchKeyword ? activeDockButtonClass : dockButtonClass}
                title="Search Books"
              >
                <Search size={desktopDockIconSize} />
              </button>

              <button
                onClick={() => { setShowImportConfirm(true); }}
                className={accentDockButtonClass}
                title="Add Local Book"
              >
                <FilePlus size={desktopDockIconSize} />
              </button>

              <button
                onClick={onToggleSortMode}
                className={dockButtonClass}
                title={getSortTitle()}
              >
                <div className="flex items-center justify-center relative">
                  {getSortIcon(desktopDockIconSize)}
                  <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-accent-500 text-white rounded-sm px-0.5 pointer-events-none">
                    {sortMode === 'alpha' ? 'A' : 'R'}
                  </span>
                </div>
              </button>

              <button
                onClick={onToggleViewMode}
                className={dockButtonClass}
                title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
              >
                {viewMode === 'grid' ? <List size={desktopDockIconSize} /> : <LayoutGrid size={desktopDockIconSize} />}
              </button>

              <button
                onClick={() => { setShowThemeModal(true); }}
                className={dockButtonClass}
                title="Change Theme"
              >
                <Palette size={desktopDockIconSize} />
              </button>

              <button
                onClick={() => { setShowManage(true); }}
                className={dockButtonClass}
                title="Manage Offline Books"
              >
                <HardDrive size={desktopDockIconSize} />
              </button>

              {isGuest ? (
                <button
                  onClick={onLogin}
                  className={accentDockButtonClass}
                  title="Sign In"
                >
                  <KeyRound size={desktopDockIconSize} />
                </button>
              ) : (
                <button
                  onClick={onLogout}
                  className={dangerDockButtonClass}
                  title="Sign Out"
                >
                  <LogOut size={desktopDockIconSize} />
                </button>
              )}
            </div>

            <div className={`${mobileHeaderDockClass} md:hidden`}>
              <button
                onClick={() => setShowSearch(true)}
                className={mobileSearchButtonClass}
                title="Search Books"
              >
                <Search size={mobileHeaderIconSize} />
              </button>

              <button
                onClick={() => setShowMobileMenu(!showMobileMenu)}
                className={mobileMenuButtonClass}
                aria-label={showMobileMenu ? "Close menu" : "Open menu"}
              >
                {showMobileMenu ? <X size={mobileHeaderIconSize} /> : <Menu size={mobileHeaderIconSize} />}
              </button>
            </div>
          </div>
      </div>
      </header>
      {typeof document !== 'undefined' && mobileDock && createPortal(mobileDock, document.body)}
    </>
  );
};
