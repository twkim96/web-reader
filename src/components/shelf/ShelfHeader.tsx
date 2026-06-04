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

  useEffect(() => {
    if (!showMobileMenu) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(e.target as Node)) {
        setShowMobileMenu(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showMobileMenu]);

  const getSortIcon = () => {
    if (sortMode === 'alpha') return <ArrowDownAZ size={20} />;
    return <Clock size={20} />;
  };

  const getSortTitle = () => {
    if (sortMode === 'alpha') return "가나다순";
    return "최근에 읽은 순";
  };

  const dockClass = `rounded-[2.25rem] border ${theme.border} ${theme.secondary} p-2 shadow-[0_18px_55px_rgba(0,0,0,0.18)] backdrop-blur-xl`;
  const dockButtonClass = "flex h-14 w-14 items-center justify-center rounded-2xl opacity-65 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const activeDockButtonClass = "flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-600 text-white opacity-100 shadow-lg shadow-accent-500/20 transition-all active:scale-90";
  const accentDockButtonClass = `${dockButtonClass} text-accent-500`;
  const dangerDockButtonClass = "flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400 opacity-100 transition-all hover:bg-red-500/20 active:scale-90";

  return (
    <header className={`sticky top-0 z-40 ${theme.bg}/80 backdrop-blur-md px-6 py-6 transition-colors duration-300`}>
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-4">
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
          <div className={`flex items-center gap-1.5 ${dockClass}`}>
            <button
              onClick={() => setShowSearch(true)}
              className={searchKeyword ? activeDockButtonClass : dockButtonClass}
              title="Search Books"
            >
              <Search size={20} />
            </button>

            <button
              onClick={() => setShowMobileMenu(!showMobileMenu)}
              className={`${dockButtonClass} md:hidden`}
              aria-label={showMobileMenu ? "Close menu" : "Open menu"}
            >
              {showMobileMenu ? <X size={20} /> : <Menu size={20} />}
            </button>

            <div className="hidden items-center gap-1.5 md:flex">
              <button
                onClick={() => { setShowImportConfirm(true); }}
                className={accentDockButtonClass}
                title="Add Local Book"
              >
                <FilePlus size={20} />
              </button>

              <button
                onClick={onToggleSortMode}
                className={dockButtonClass}
                title={getSortTitle()}
              >
                <div className="flex items-center justify-center relative">
                  {getSortIcon()}
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
                {viewMode === 'grid' ? <List size={20} /> : <LayoutGrid size={20} />}
              </button>

              <button
                onClick={() => { setShowThemeModal(true); }}
                className={dockButtonClass}
                title="Change Theme"
              >
                <Palette size={20} />
              </button>

              <button
                onClick={() => { setShowManage(true); }}
                className={dockButtonClass}
                title="Manage Offline Books"
              >
                <HardDrive size={20} />
              </button>

              {isGuest ? (
                <button
                  onClick={onLogin}
                  className={accentDockButtonClass}
                  title="Sign In"
                >
                  <KeyRound size={20} />
                </button>
              ) : (
                <button
                  onClick={onLogout}
                  className={dangerDockButtonClass}
                  title="Sign Out"
                >
                  <LogOut size={20} />
                </button>
              )}
            </div>
          </div>

          <div className={`fixed inset-y-0 right-[calc(env(safe-area-inset-right)+1rem)] z-[80] items-center md:hidden ${showMobileMenu ? 'flex' : 'hidden'}`}>
            <div className={`flex flex-col gap-1.5 ${dockClass} animate-in fade-in slide-in-from-right-4 duration-200`}>
              <button
                onClick={() => { setShowMobileMenu(false); setShowImportConfirm(true); }}
                className={accentDockButtonClass}
                title="Add Local Book"
              >
                <FilePlus size={20} />
              </button>

              <button
                onClick={() => { setShowMobileMenu(false); onToggleSortMode(); }}
                className={dockButtonClass}
                title={getSortTitle()}
              >
                <div className="flex items-center justify-center relative">
                  {getSortIcon()}
                  <span className="absolute -bottom-1 -right-1 text-[8px] font-bold bg-accent-500 text-white rounded-sm px-0.5 pointer-events-none">
                    {sortMode === 'alpha' ? 'A' : 'R'}
                  </span>
                </div>
              </button>

              <button
                onClick={() => { setShowMobileMenu(false); onToggleViewMode(); }}
                className={dockButtonClass}
                title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
              >
                {viewMode === 'grid' ? <List size={20} /> : <LayoutGrid size={20} />}
              </button>

              <button
                onClick={() => { setShowMobileMenu(false); setShowThemeModal(true); }}
                className={dockButtonClass}
                title="Change Theme"
              >
                <Palette size={20} />
              </button>

              <button
                onClick={() => { setShowMobileMenu(false); setShowManage(true); }}
                className={dockButtonClass}
                title="Manage Offline Books"
              >
                <HardDrive size={20} />
              </button>

              {isGuest ? (
                <button
                  onClick={() => { setShowMobileMenu(false); onLogin(); }}
                  className={accentDockButtonClass}
                  title="Sign In"
                >
                  <KeyRound size={20} />
                </button>
              ) : (
                <button
                  onClick={() => { setShowMobileMenu(false); onLogout(); }}
                  className={dangerDockButtonClass}
                  title="Sign Out"
                >
                  <LogOut size={20} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
