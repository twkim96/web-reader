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

  return (
    <header className={`sticky top-0 z-40 ${theme.bg}/80 backdrop-blur-md border-b ${theme.border} px-6 py-6 transition-colors duration-300`}>
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
        
        <div className="flex items-center gap-2" ref={mobileMenuRef}>
          <button 
            onClick={() => setShowSearch(true)}
            className={`p-4 rounded-2xl border transition-all active:scale-90 ${
              searchKeyword 
                ? 'bg-accent-600 border-accent-500 text-white shadow-lg shadow-accent-500/20' 
                : `${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100`
            }`}
            title="Search Books"
          >
            <Search size={20} />
          </button>

          <button
            onClick={() => setShowMobileMenu(!showMobileMenu)}
            className={`md:hidden p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
          >
            {showMobileMenu ? <X size={20} /> : <Menu size={20} />}
          </button>

          <div className={`
            absolute top-[88px] right-6 p-4 rounded-3xl border shadow-2xl flex flex-col gap-2 
            md:static md:p-0 md:bg-transparent md:border-none md:shadow-none md:flex-row md:flex
            ${theme.bg} ${theme.border}
            ${showMobileMenu ? 'animate-in fade-in slide-in-from-top-4 flex' : 'hidden'}
          `}>
            <button
              onClick={() => { setShowMobileMenu(false); setShowImportConfirm(true); }}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90 text-accent-500`}
              title="Add Local Book"
            >
              <FilePlus size={20} />
            </button>

            <button
              onClick={() => { setShowMobileMenu(false); onToggleSortMode(); }}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
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
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title={viewMode === 'grid' ? "Switch to List View" : "Switch to Grid View"}
            >
              {viewMode === 'grid' ? <List size={20} /> : <LayoutGrid size={20} />}
            </button>

            <button
              onClick={() => { setShowMobileMenu(false); setShowThemeModal(true); }}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title="Change Theme"
            >
              <Palette size={20} />
            </button>

            <button 
              onClick={() => { setShowMobileMenu(false); setShowManage(true); }}
              className={`p-4 rounded-2xl ${theme.secondary} border ${theme.border} opacity-60 hover:opacity-100 transition-all active:scale-90`}
              title="Manage Offline Books"
            >
              <HardDrive size={20} />
            </button>

            {isGuest ? (
              <button 
                onClick={() => { setShowMobileMenu(false); onLogin(); }}
                className="p-4 rounded-2xl bg-accent-500/10 border border-accent-500/20 text-accent-400 hover:bg-accent-500 hover:text-white transition-all active:scale-90"
                title="Sign In"
              >
                <KeyRound size={20} />
              </button>
            ) : (
              <button 
                onClick={() => { setShowMobileMenu(false); onLogout(); }}
                className="p-4 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500 hover:text-white transition-all active:scale-90"
                title="Sign Out"
              >
                <LogOut size={20} />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
