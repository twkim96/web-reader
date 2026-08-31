import React from 'react';
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
  EllipsisVertical,
  X
} from 'lucide-react';
import type { CloudSyncStatus } from './FileUploader';
import type { ShelfSortMode, ShelfViewMode } from './bookUtils';
import type { ShelfDockStyle } from '../../types';

interface ShelfHeaderProps {
  isOfflineMode: boolean;
  isGuest: boolean;
  syncStatus: CloudSyncStatus;
  userEmail: string;
  searchKeyword: string;
  sortMode: ShelfSortMode;
  activeFilterCount: number;
  viewMode: ShelfViewMode;
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
  const sortLabel = sortMode === 'alpha'
    ? '가나다순'
    : sortMode === 'popularity'
      ? '통합 인기순'
      : '최근에 읽은 순';
  const filterActive = sortMode !== 'recent' || activeFilterCount > 0;
  const filterTitle = `책장 정렬·필터: ${sortLabel}${
    activeFilterCount > 0 ? `, 필터 ${activeFilterCount}개` : ''
  }`;
  const [mobileMoreOpen, setMobileMoreOpen] = React.useState(false);

  React.useEffect(() => {
    if (!mobileMoreOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMoreOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileMoreOpen]);

  const bottomDockIconSize = 26;
  const mobileHeaderIconSize = 22;
  const modernDock = dockStyle === 'modern';
  const standardDock = dockStyle === 'standard';
  const dockSurfaceClass = modernDock
    ? "shelf-muzio-dock text-[color:var(--viewer-theme-text)]"
    : standardDock
      ? "text-[color:var(--viewer-theme-text)]"
      : "viewer-cime-glass text-[color:var(--viewer-shelf-glass-ink)]";
  const bottomDockFrameClass = "relative w-[calc(100vw-4.25rem)] max-w-[20.75rem] md:w-fit md:max-w-[calc(100vw-1rem)]";
  const bottomDockClass = `app-menu-dock relative flex h-[4.25rem] w-full items-center justify-center rounded-[34px] ${dockSurfaceClass} px-1 md:h-[4.5rem] md:w-fit md:px-3`;
  const bottomDockButtonBaseClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full opacity-[0.84] transition-[transform,opacity,background-color] duration-150 hover:bg-current/10 hover:opacity-100 active:scale-90 md:h-14 md:w-14";
  const bottomDockButtonClass = `${bottomDockButtonBaseClass} shelf-glass-contrast-icon`;
  const activeBottomDockButtonClass = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-600 text-white opacity-100 shadow-[0_5px_16px_rgba(0,0,0,0.18)] transition-[transform,background-color] duration-150 active:scale-90 md:h-14 md:w-14";
  const accentBottomDockButtonClass = `${bottomDockButtonBaseClass} text-accent-500`;
  const mobileHeaderButtonClass = "flex size-10 shrink-0 items-center justify-center rounded-xl bg-transparent p-0 opacity-75 transition-all hover:bg-current/10 hover:opacity-100 active:scale-90";
  const renderLayoutControls = ({
    iconSize,
    buttonClass,
  }: {
    iconSize: number;
    buttonClass: string;
  }) => {
    const nextViewTitle = viewMode === 'simple'
      ? 'Switch to Grid View'
      : viewMode === 'grid'
        ? 'Switch to List View'
        : 'Switch to Simple View';
    const nextViewLabel = viewMode === 'simple'
      ? '그리드 보기'
      : viewMode === 'grid'
        ? '목록 보기'
        : '심플 보기';

    return (
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
        title={nextViewTitle}
        aria-label={nextViewLabel}
      >
        {viewMode === 'simple'
          ? <LayoutGrid size={iconSize} />
          : viewMode === 'grid'
            ? <List size={iconSize} />
            : <Library size={iconSize} />}
      </button>
      </>
    );
  };

  const renderDockActions = ({
    iconSize,
    buttonClass,
    activeButtonClass,
    accentButtonClass,
    includeLayoutControls = true,
    layoutControlsClassName = '',
  }: {
    iconSize: number;
    buttonClass: string;
    activeButtonClass: string;
    accentButtonClass: string;
    includeLayoutControls?: boolean;
    layoutControlsClassName?: string;
  }) => {
    const runAction = (action: () => void) => {
      setMobileMoreOpen(false);
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
          data-shelf-dock-action="annotations"
          onClick={() => runAction(onShowAnnotations)}
          className={`${buttonClass} hidden md:flex`}
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
          data-shelf-dock-action="offline-storage"
          onClick={() => runAction(() => setShowManage(true))}
          className={`${buttonClass} hidden md:flex`}
          title="Manage Offline Books"
        >
          <HardDrive size={iconSize} />
        </button>

        <button
          type="button"
          data-shelf-more-control="true"
          onClick={() => setMobileMoreOpen((current) => !current)}
          className={`${buttonClass} md:hidden ${mobileMoreOpen ? 'bg-current/10 opacity-100' : ''}`}
          title="더보기"
          aria-label="더보기"
          aria-haspopup="menu"
          aria-expanded={mobileMoreOpen}
          aria-controls="shelf-mobile-more-menu"
        >
          <EllipsisVertical size={iconSize} />
        </button>

      </>
    );
  };

  const bottomDock = (
    <>
      {mobileMoreOpen && (
        <button
          type="button"
          data-shelf-more-backdrop="true"
          className="fixed inset-0 z-[79] cursor-default bg-transparent md:hidden"
          onClick={() => setMobileMoreOpen(false)}
          aria-label="더보기 메뉴 닫기"
        />
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.25rem)] z-[80] flex justify-center px-2 md:bottom-[calc(env(safe-area-inset-bottom)+1.5rem)]">
        <div className={`${bottomDockFrameClass} pointer-events-auto`}>
          {mobileMoreOpen && (
            <div
              id="shelf-mobile-more-menu"
              role="menu"
              tabIndex={-1}
              autoFocus
              data-shelf-more-menu="true"
              data-menu-style-material={dockStyle}
              aria-label="책장 더보기"
              className={`app-menu-dock app-panel-radius absolute bottom-[calc(100%+0.5rem)] right-0 z-10 w-56 origin-bottom-right ${dockSurfaceClass} p-2 animate-in fade-in zoom-in-95 duration-150 md:hidden`}
            >
              <button
                type="button"
                role="menuitem"
                data-shelf-more-action="offline-storage"
                onClick={() => {
                  setMobileMoreOpen(false);
                  setShowManage(true);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors hover:bg-current/10 active:bg-current/15"
              >
                <span className="app-menu-sheet-action app-radius-exempt shelf-glass-contrast-icon flex size-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--app-menu-control-border)]">
                  <HardDrive size={21} />
                </span>
                <span>오프라인 스토리지</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-shelf-more-action="annotations"
                onClick={() => {
                  setMobileMoreOpen(false);
                  onShowAnnotations();
                }}
                className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors hover:bg-current/10 active:bg-current/15"
              >
                <span className="app-menu-sheet-action app-radius-exempt shelf-glass-contrast-icon flex size-10 shrink-0 items-center justify-center rounded-full border border-[color:var(--app-menu-control-border)]">
                  <Highlighter size={21} />
                </span>
                <span>라이브러리 주석</span>
              </button>
            </div>
          )}
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
      </div>
    </>
  );

  return (
    <>
      <header className="relative z-40 pt-[calc(env(safe-area-inset-top)+0.5rem)] pb-2 transition-colors duration-300">
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
              <span className="flex size-10 shrink-0 items-center justify-center text-accent-500 opacity-90 transition-opacity group-hover:opacity-100">
                {isGuest ? (
                  <KeyRound size={31} />
                ) : isOfflineMode ? (
                  <WifiOff size={31} />
                ) : (
                  <Library size={31} />
                )}
              </span>
              <span className="min-w-0">
                <span
                  role="heading"
                  aria-level={1}
                  data-shelf-library-label="true"
                  className="block truncate whitespace-nowrap text-[21px] font-medium tracking-tight md:text-[22px]"
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

          <div
            data-shelf-mobile-layout-controls="true"
            className="ml-1 flex shrink-0 items-center gap-0.5"
          >
            <span className="flex items-center gap-0.5 md:hidden">
              {renderLayoutControls({
                iconSize: mobileHeaderIconSize,
                buttonClass: mobileHeaderButtonClass,
              })}
            </span>
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
      </div>
      </header>
      {bottomDock}
    </>
  );
};
