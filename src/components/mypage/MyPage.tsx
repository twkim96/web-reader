'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Archive, BookCopy, BookOpen, ChartNoAxesColumn, Check, Compass, House, Library, Plus, Search, Settings2 } from 'lucide-react';
import type { Book, ThemeClasses, UserProgress } from '../../types';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { groupDiscoveryBooks, loadBookDiscovery, resolveReadBookDiscovery, type DiscoveryBook } from '../../lib/bookDiscovery';
import { bookDetailHref, hasBookReviewTarget, readBookDetailId } from '../../lib/bookDetail';
import type { ReadBook } from '../../lib/readBooks';
import { useAccountWishlist } from '../../hooks/useAccountWishlist';
import { useMyPageReviews } from '../../hooks/useMyPageReviews';
import { ReadingDashboard } from './ReadingDashboard';
import { ReadBooks } from './ReadBooks';
import { BookCover } from './BookCover';
import { BookDetail } from './BookDetail';
import { BookDetailLink } from './BookDetailLink';
import { DashboardBookRow } from './DashboardBookRow';
import { MyPageSharingSettings } from './SocialPanels';
import { PublicBrowse } from './PublicBrowse';
import { MyReviews } from './MyReviews';
import { LibraryAnnotations } from '../LibraryAnnotations';
import { LibraryReadingStatisticsModal } from '../LibraryReadingStatisticsModal';
import type { SyncHealth } from '../../lib/syncHealth';

const tabLabels = {
  overview: '대시보드',
  discover: '도서목록',
  browse: '둘러보기',
  read: '읽은 책',
  wishlist: '위시리스트',
  reviews: '내 평가',
  statistics: '통계',
  annotations: '주석',
  sharing: '공개 설정',
} as const;

type Tab = keyof typeof tabLabels;
const primaryMenu = [
  { label: '홈', icon: House, tabs: ['overview'] },
  { label: '도서', icon: BookCopy, tabs: ['discover'] },
  { label: '피드', icon: Compass, tabs: ['browse'] },
  { label: '보관', icon: Archive, tabs: ['read', 'wishlist', 'reviews'] },
  { label: '기록', icon: ChartNoAxesColumn, tabs: ['statistics', 'annotations'] },
] satisfies readonly { label: string; icon: typeof House; tabs: readonly [Tab, ...Tab[]] }[];
const desktopQuery = '(min-width: 640px)';
const headerActions = [
  { id: 'shelf', label: '내 서재', icon: Library },
  { id: 'sharing', label: '공개 설정', icon: Settings2 },
] as const;
const readTab = (): Tab => {
  if (typeof window === 'undefined') return 'overview';
  const candidate = readBookDetailId(window.location.hash)
    ? window.history.state?.myPageBookFrom ?? 'discover'
    : window.location.hash.split('/')[1];
  if (candidate === 'people') return 'browse';
  return typeof candidate === 'string' && Object.hasOwn(tabLabels, candidate) ? candidate as Tab : 'overview';
};
const readDetailId = () => typeof window === 'undefined' ? null : readBookDetailId(window.location.hash);
const inputClass = 'min-h-11 min-w-0 rounded-lg px-3 ring-1 ring-inset ring-current/15 text-sm focus-visible:outline-2 focus-visible:outline-accent-500';
const titleMiddleY = (header: HTMLElement) => {
  const { top, height } = header.getBoundingClientRect();
  return top + height / 2;
};

type Props = {
  ownerKey: OwnerKey;
  books: Book[];
  progress: Record<string, UserProgress>;
  bookmarkProgress: Record<string, UserProgress>;
  theme: ThemeClasses;
  themeVariables: React.CSSProperties;
  accentColor: string;
  syncHealth: SyncHealth;
  quarantinedDocumentCount: number;
  canRefresh: boolean;
  refreshing: boolean;
  lastServerCheckedAt: number | null;
  onRefresh: () => void;
  onBack: () => void;
};

export function MyPage(props: Props) {
  const { ownerKey, books, progress, bookmarkProgress, theme, themeVariables, onBack } = props;
  const [tab, setTab] = useState<Tab>(readTab);
  const [bookId, setBookId] = useState(readDetailId);
  const [focusReview, setFocusReview] = useState(() => typeof window !== 'undefined' && hasBookReviewTarget(window.location.hash));
  const [compactMenu, setCompactMenu] = useState(false);
  const [mobileScrolled, setMobileScrolled] = useState(false);
  const titleRow = useRef<HTMLElement>(null);
  const [openedBook, setOpenedBook] = useState<{ id: string; book: DiscoveryBook | ReadBook }>();
  const readListScroll = useRef<number | null>(null);
  const restoreReadListScroll = useRef(false);
  const [catalog, setCatalog] = useState<DiscoveryBook[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [genre, setGenre] = useState('');
  const [tag, setTag] = useState('');
  const [wishlistSort, setWishlistSort] = useState('popular');
  const [discoverySort, setDiscoverySort] = useState('popular');
  const sort = tab === 'wishlist' ? wishlistSort : discoverySort;
  const setSort = tab === 'wishlist' ? setWishlistSort : setDiscoverySort;
  const [visibleCount, setVisibleCount] = useState(60);
  const signedIn = !isGuestOwner(ownerKey);
  const wishlist = useAccountWishlist(ownerKey, signedIn);
  const groupedCatalog = useMemo(() => catalog ? groupDiscoveryBooks(catalog) : null, [catalog]);
  const readBookDetailId = (book: ReadBook) =>
    groupedCatalog && book.platformWorkKeys?.length ? resolveReadBookDiscovery(groupedCatalog, book).book?.id ?? null : null;
  const reviews = useMyPageReviews(ownerKey, signedIn && (tab === 'read' || Boolean(bookId)));
  useLayoutEffect(() => {
    const header = titleRow.current;
    if (!header) return;
    const desktop = window.matchMedia?.(desktopQuery);
    let compact = false;
    let mobileHeaderScrolled = false;
    const update = () => {
      const wide = desktop?.matches ?? true;
      const next = wide && titleMiddleY(header) <= 0;
      if (compact !== next) {
        compact = next;
        setCompactMenu(next);
      }
      const scrolled = !wide && window.scrollY > 0;
      if (mobileHeaderScrolled !== scrolled) {
        mobileHeaderScrolled = scrolled;
        setMobileScrolled(scrolled);
      }
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  const navigate = (next: Tab) => {
    if (next === tab && !bookId) return;
    readListScroll.current = null;
    window.history.pushState(null, '', `#mypage/${next}`);
    setTab(next);
    setBookId(null);
    setFocusReview(false);
    if (window.matchMedia?.(desktopQuery).matches === false) {
      window.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }
    const titleMiddle = titleRow.current ? titleMiddleY(titleRow.current) : undefined;
    if (titleMiddle !== undefined && titleMiddle < 0) {
      window.scrollTo({ top: Math.ceil(window.scrollY + titleMiddle), behavior: 'instant' });
    }
  };
  const openBookById = (id: string, book?: DiscoveryBook | ReadBook, reviewTarget = false) => {
    if (tab === 'read') readListScroll.current = window.scrollY;
    window.history.pushState({ ...window.history.state, myPageBookFrom: tab }, '', bookDetailHref(id, reviewTarget));
    setOpenedBook(book ? { id, book } : undefined);
    setBookId(id);
    setFocusReview(reviewTarget);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const openBook = (book: DiscoveryBook | ReadBook, reviewTarget = false) => {
    const id = 'platforms' in book ? book.id : readBookDetailId(book);
    if (id !== null) openBookById(id, book, reviewTarget);
  };
  const closeBook = () => {
    if (window.history.state?.myPageBookFrom) window.history.back();
    else navigate('discover');
  };
  useEffect(() => {
    const update = () => {
      const nextTab = readTab();
      const nextBook = readDetailId();
      restoreReadListScroll.current = nextTab === 'read' && nextBook === null;
      setTab(nextTab);
      setBookId(nextBook);
      setFocusReview(hasBookReviewTarget(window.location.hash));
    };
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  useLayoutEffect(() => {
    if (!restoreReadListScroll.current || bookId || tab !== 'read') return;
    restoreReadListScroll.current = false;
    if (readListScroll.current !== null) window.scrollTo({ top: readListScroll.current, behavior: 'instant' });
  }, [bookId, tab]);
  const matchingSource = openedBook?.id === bookId ? openedBook?.book : undefined;
  const readSource = matchingSource && !('platforms' in matchingSource) ? matchingSource : undefined;
  const discoverySource = matchingSource && 'platforms' in matchingSource ? matchingSource : undefined;
  const browse = tab === 'discover' || tab === 'wishlist';
  const searchableTitles = useMemo(() => {
    const titles = new Map<string, string[]>();
    for (const item of (browse ? catalog ?? [] : [])) {
      const id = groupedCatalog?.byId.get(item.id)?.id ?? item.id;
      const values = titles.get(id) ?? [];
      values.push(item.title.normalize('NFC').toLocaleLowerCase());
      titles.set(id, values);
    }
    return titles;
  }, [browse, catalog, groupedCatalog]);
  const readMatch = readSource && groupedCatalog ? resolveReadBookDiscovery(groupedCatalog, readSource) : undefined;
  const detailBook = !bookId ? undefined : readSource ? readMatch?.book : groupedCatalog?.byId.get(bookId)
    ?? discoverySource ?? wishlist.entries.find(({ book }) => book.id === bookId)?.book;
  const detailSaved = bookId !== null && !readMatch?.blocked
    && (wishlist.savedIds.has(bookId) || (detailBook !== undefined && wishlist.savedIds.has(detailBook.id)));
  const catalogLoading = !catalog && !catalogError;
  const needsCatalog = Boolean(bookId) || tab === 'discover' || (signedIn && (tab === 'read' || tab === 'overview'));
  useEffect(() => {
    if (!needsCatalog || catalog) return;
    let active = true;
    void loadBookDiscovery().then((result) => {
      if (active) { setCatalog(result); setCatalogError(false); }
    }).catch(() => { if (active) setCatalogError(true); });
    return () => { active = false; };
  }, [catalog, needsCatalog, retry]);
  const retryCatalog = () => { setCatalogError(false); setRetry((value) => value + 1); };
  const list = useMemo(() => tab === 'wishlist'
    ? wishlist.entries.map((entry) => entry.book) : tab === 'discover' ? groupedCatalog?.books ?? [] : [], [groupedCatalog, tab, wishlist.entries]);
  const genres = useMemo(() => [...new Set(list.flatMap((book) => book.genre ? [book.genre] : []))].sort(), [list]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const book of list) for (const name of book.tags) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 120).map(([name]) => name);
  }, [list]);
  const sorted = useMemo(() => {
    const byTitle = (a: DiscoveryBook, b: DiscoveryBook) => a.title.localeCompare(b.title, 'ko');
    const ordered = [...list];
    if (sort === 'title') ordered.sort(byTitle);
    if (sort === 'popular') ordered.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || byTitle(a, b));
    if (sort === 'views') ordered.sort((a, b) => (b.sourceCount ?? -1) - (a.sourceCount ?? -1) || byTitle(a, b));
    return ordered.map((book) => ({
      book, titles: searchableTitles.get(book.id) ?? [book.title.normalize('NFC').toLocaleLowerCase()],
    }));
  }, [list, searchableTitles, sort]);
  const results = useMemo(() => {
    const normalized = query.trim().normalize('NFC').toLocaleLowerCase();
    return sorted.filter(({ book, titles }) => (
      (!normalized || titles.some((title) => title.includes(normalized)))
      && (!source || book.platforms.some((platform) => platform.id === source))
      && (!genre || book.genre === genre)
      && (!tag || book.tags.includes(tag))
    )).map(({ book }) => book);
  }, [genre, query, sorted, source, tag]);
  const resetFilters = () => { setQuery(''); setSource(''); setGenre(''); setTag(''); setVisibleCount(60); };
  const openTab = (next: Tab) => { resetFilters(); navigate(next); };
  const detailLabel = tabLabels[tab];
  const activeGroup = primaryMenu.find(({ tabs }) => tabs.some((id) => id === tab));
  const loading = tab === 'discover' ? !catalog && !catalogError : wishlist.loading;
  const headerActionPosition = compactMenu ? '' : 'translate-y-[calc(-1.625rem_-_var(--mypage-title-height)/2)]';
  const headerActionMotion = 'motion-safe:transition-[translate,background-color] motion-safe:duration-200';
  const headerButton = 'flex size-11 items-center justify-center rounded-full hover:bg-current/10';
  const title = bookId ? '도서 상세정보' : '마이페이지';
  const backButton = (
    <button type="button" onClick={bookId ? closeBook : onBack} aria-label={bookId ? '도서 목록으로 돌아가기' : '서재로 돌아가기'}
      className={`${headerButton} transition-colors`}><ArrowLeft size={19} /></button>
  );
  const shortcuts = (
    <div role="group" aria-label="마이페이지 바로가기" className="flex">
      {headerActions.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" aria-label={label} title={label} aria-current={tab === id ? 'page' : undefined}
          onClick={id === 'shelf' ? onBack : () => openTab(id)}
          className={`${headerButton} transition-colors ${(compactMenu || mobileScrolled) && tab === id ? 'text-accent-500' : ''}`}>
          <Icon size={19} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
  const mainItems = primaryMenu.map((group) => {
    const selected = group === activeGroup;
    const { icon: Icon, label, tabs: [firstTab] } = group;
    return (
      <button key={firstTab} type="button" aria-current={selected ? 'page' : undefined}
        onClick={() => openTab(selected ? tab : firstTab)}
        className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap px-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 sm:min-h-11 sm:flex-row sm:gap-1.5 sm:rounded-xl sm:px-2.5 sm:text-sm ${selected ? 'font-semibold text-accent-500 sm:bg-accent-500/10' : 'font-medium opacity-65 hover:bg-current/5 hover:opacity-100'}`}>
        <Icon size={19} aria-hidden="true" className="shrink-0" />
        <span>{label}</span>
      </button>
    );
  });

  return (
    <div data-my-page="true" className="min-h-dvh [--mypage-title-height:6rem] [--mypage-title-half:calc(var(--mypage-title-height)/2)]" style={{ ...themeVariables, backgroundColor: 'var(--viewer-theme-bg)', color: 'var(--viewer-theme-text)' }}>
      <header ref={titleRow} className="hidden sm:block">
        <div className="mx-auto flex h-[var(--mypage-title-height)] max-w-5xl items-center pl-[5.25rem] pr-32">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      <div className="pointer-events-none sticky top-0 z-30 -mt-[var(--mypage-title-half)] hidden pt-[var(--mypage-title-half)] sm:block">
        <div data-mypage-menu={compactMenu ? 'compact' : 'expanded'}
          className={`pointer-events-auto bg-[var(--viewer-theme-bg)] motion-safe:transition-[translate] motion-safe:duration-200 ${compactMenu ? '-translate-y-[var(--mypage-title-half)]' : ''}`}>
          <div className="relative mx-auto max-w-5xl px-5 py-1 sm:px-8">
            <div className={`absolute left-8 top-1 ${headerActionMotion} ${headerActionPosition}`}>{backButton}</div>
            <div className={`absolute right-8 top-1 z-10 ${headerActionMotion} ${headerActionPosition}`}>{shortcuts}</div>
            {compactMenu && (
              <span aria-hidden="true" data-mypage-header-divider className="pointer-events-none absolute right-[6.75rem] top-4.5 h-4 w-px bg-current/25 sm:right-[7.5rem]" />
            )}
            <nav aria-label="마이페이지 메뉴" className={`flex gap-1 motion-safe:transition-[margin] motion-safe:duration-200 ${compactMenu ? 'ml-[3.25rem] mr-24' : ''}`}>
              {mainItems}
            </nav>
          </div>
        </div>
      </div>
      <header data-mypage-mobile-header className="sticky top-0 z-30 bg-[var(--viewer-theme-bg)] pt-[env(safe-area-inset-top)] sm:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-3">
          {backButton}
          <h1 className={mobileScrolled ? 'sr-only' : 'min-w-0 flex-1 truncate text-lg font-semibold tracking-tight'}>{title}</h1>
          {shortcuts}
        </div>
      </header>
      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-current/10 bg-[var(--viewer-theme-bg)] pb-[env(safe-area-inset-bottom)] sm:hidden">
        <nav aria-label="마이페이지 하단 메뉴" className="grid grid-cols-5">
          {mainItems}
        </nav>
      </footer>
      <div className="mx-auto max-w-5xl px-5 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-8 sm:pb-14 sm:pt-8">
        {!bookId && activeGroup && activeGroup.tabs.length > 1 && (
          <nav aria-label={`${activeGroup.label} 메뉴`} className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 mb-6 flex flex-wrap gap-x-5 bg-[var(--viewer-theme-bg)] sm:top-[3.25rem] sm:mb-8 sm:gap-x-7">
            {activeGroup.tabs.map((id) => (
              <button key={id} type="button" onClick={() => openTab(id)} aria-current={tab === id ? 'page' : undefined}
                className={`min-h-11 whitespace-nowrap border-b-2 px-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent-500 ${tab === id ? 'border-accent-500 font-semibold text-accent-500' : 'border-transparent opacity-65 hover:opacity-100'}`}>
                {tabLabels[id]}
              </button>
            ))}
          </nav>
        )}
        <main className="min-w-0 space-y-4 sm:space-y-6" aria-label={bookId ? '도서 상세정보' : detailLabel}>
          {tab === 'read' && <div hidden={Boolean(bookId)}><ReadBooks key={ownerKey} ownerKey={ownerKey} onOpenBook={openBook} getDetailId={readBookDetailId} onRetryCatalog={catalogError ? retryCatalog : undefined} reviews={reviews.data?.reviews} reviewError={reviews.error} onRetryReviews={reviews.refresh} /></div>}
          {tab === 'browse' && <div hidden={Boolean(bookId)}><PublicBrowse key={ownerKey} owner={ownerKey} onOpenBook={openBookById} /></div>}
          {tab === 'overview' && <div hidden={Boolean(bookId)} className="space-y-8 [--mypage-cover-width:clamp(3.85rem,20.3vw,5.25rem)] sm:space-y-10">
            <DashboardBookRow title="읽고 싶은 도서" books={wishlist.entries.map(({ book }) => book)}
              onOpenBook={openBook} onShowAll={() => openTab('wishlist')}>
              {wishlist.loading ? <p role="status" className="text-sm opacity-60">위시리스트를 불러오는 중…</p>
                : !wishlist.error && wishlist.entries.length === 0 && <div className="flex flex-wrap items-center gap-x-4">
                  <p className="text-sm opacity-60">담아둔 책이 없습니다.</p>
                  <button type="button" onClick={() => openTab('discover')} className="flex min-h-10 items-center gap-1.5 text-xs font-semibold text-accent-500"><Plus size={16} />도서 찾아보기</button>
                </div>}
            </DashboardBookRow>
            <ReadBooks key={`read:${ownerKey}`} ownerKey={ownerKey} onShowAll={() => openTab('read')} onOpenBook={openBook} getDetailId={readBookDetailId} onRetryCatalog={catalogError ? retryCatalog : undefined} />
            <MyReviews key={`reviews:${ownerKey}:${reviews.changeVersion}`} owner={ownerKey} onShowAll={() => openTab('reviews')} onOpenBook={openBookById} />
            <ReadingDashboard ownerKey={ownerKey} onOpenStatistics={() => openTab('statistics')} onOpenAnnotations={() => openTab('annotations')} />
          </div>}
          {bookId ? (
            <BookDetail key={`${ownerKey}:${bookId}`} bookId={bookId} discovery={detailBook} readBook={readSource} ownerKey={ownerKey} books={books} progress={progress} bookmarkProgress={bookmarkProgress} catalogLoading={catalogLoading && !detailBook} identityBlocked={Boolean(readMatch?.blocked || (catalogError && readSource?.platformWorkKeys?.length))} saved={detailSaved} reviews={reviews} focusReview={focusReview} />
          ) : <>
          {wishlist.error && <p role="alert" className="text-sm text-accent-500">{wishlist.error} {signedIn && <button type="button" onClick={() => void wishlist.refresh()} className="underline">위시리스트 다시 불러오기</button>}</p>}
          {tab === 'reviews' && (signedIn ? <MyReviews key={ownerKey} owner={ownerKey} onOpenBook={openBookById} changeVersion={reviews.changeVersion} />
            : <p className="mypage-section text-sm">내 평가는 로그인 후 이용할 수 있습니다.</p>)}
          {tab === 'sharing' && (signedIn
            ? <MyPageSharingSettings key={ownerKey} owner={ownerKey} onWishlistImported={() => void wishlist.refresh()} />
            : <p className="mypage-section text-sm">공개 설정은 로그인 후 이용할 수 있습니다.</p>)}
          {browse && <>
            <div className="flex items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">{detailLabel}</h2><p className="mt-1.5 text-xs opacity-45">{tab === 'wishlist' ? `담아둔 책 ${wishlist.entries.length.toLocaleString()}권` : groupedCatalog ? `공개 메타데이터 ${groupedCatalog.books.length.toLocaleString()}권` : '공개 메타데이터에서 읽고 싶은 책을 찾아보세요.'}</p></div>{tab === 'wishlist' && <button type="button" onClick={() => openTab('discover')} className="flex min-h-10 items-center gap-1.5 rounded-full bg-accent-500 px-4 text-xs font-semibold text-white"><Plus size={15} />추가</button>}</div>
            <section aria-label="도서 검색 및 필터" className="space-y-2.5">
              <label className="flex items-center gap-2.5 rounded-lg px-3 ring-1 ring-inset ring-current/15 focus-within:outline-2 focus-within:outline-accent-500"><Search size={17} className="shrink-0 opacity-60" /><input aria-label="도서 제목 검색" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(60); }} placeholder="도서 제목 검색" className="min-h-10 min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <select aria-label="도서 플랫폼 필터" value={source} onChange={(event) => { setSource(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 플랫폼</option><option value="series">네이버 시리즈</option><option value="kakao">카카오페이지</option><option value="novelpia">노벨피아</option></select>
                <select aria-label="도서 장르 필터" value={genre} onChange={(event) => { setGenre(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 장르</option>{genres.map((name) => <option key={name}>{name}</option>)}</select>
                <select aria-label="도서 태그 필터" value={tag} onChange={(event) => { setTag(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 태그</option>{tags.map((name) => <option key={name}>{name}</option>)}</select>
                <select aria-label="도서 정렬" value={sort} onChange={(event) => setSort(event.target.value)} className={inputClass}><option value="popular">인기순</option><option value="views">조회·다운로드순</option><option value="title">가나다순</option>{tab === 'wishlist' && <option value="saved">담은 순</option>}</select>
              </div>
            </section>
            <section aria-label="도서 목록">
              {loading ? <div role="status" className="py-10 text-center text-sm opacity-65">{tab === 'discover' ? '도서 정보를 불러오는 중…' : '위시리스트를 불러오는 중…'}</div>
              : tab === 'discover' && catalogError ? <div role="alert" className="py-8 text-center"><p className="text-sm opacity-70">도서 정보를 불러오지 못했습니다.</p><button type="button" onClick={retryCatalog} className="mt-3 min-h-10 px-3 text-sm font-medium text-accent-500">다시 시도</button></div>
              : results.length === 0 ? <div className="py-8 text-center"><BookOpen size={28} className="mx-auto mb-3 opacity-40" /><p className="text-sm opacity-70">{list.length === 0 ? tab === 'wishlist' ? '담아둔 책이 없습니다.' : '공개된 도서 정보가 없습니다.' : '조건에 맞는 책이 없습니다.'}</p>{list.length > 0 && <button type="button" onClick={resetFilters} className="mt-3 text-sm text-accent-500">필터 초기화</button>}</div>
              : <div className="mypage-divided-list">
                {results.slice(0, visibleCount).map((book) => {
                  const saved = wishlist.savedIds.has(book.id);
                  return <article key={book.id} className="mypage-book-list-item flex items-center">
                    <BookDetailLink bookId={book.id} onOpen={() => openBook(book)} label={book.title} className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg pr-3 sm:gap-4 sm:pr-4">
                      <BookCover url={book.coverUrl} />
                      <div className="min-w-0 flex-1">
                        <h3 className="line-clamp-2 text-sm font-semibold leading-6 group-hover:text-accent-500">{book.title}</h3>
                        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] leading-5 opacity-50">{book.genre && <span>{book.genre}</span>}{[...new Set(book.platforms.map(({ label }) => label))].map((label) => <span key={label}>{label}</span>)}{book.sourceCount !== null && <span>{new Intl.NumberFormat('ko', { notation: 'compact', maximumFractionDigits: 1 }).format(book.sourceCount)} 조회·다운로드</span>}</div>
                        {book.tags.length > 0 && <p className="mt-1 truncate text-[11px] opacity-40">{book.tags.slice(0, 5).map((name) => `#${name}`).join(' ')}</p>}
                      </div>
                    </BookDetailLink>
                    <button type="button" aria-label={`${book.title} 위시리스트 ${saved ? '제거' : '추가'}`} aria-pressed={saved} disabled={wishlist.loading || wishlist.saving} onClick={() => void wishlist.setSaved(book, !saved)} className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${saved ? 'bg-accent-500/10 text-accent-500' : 'opacity-65 hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] hover:text-accent-500 hover:opacity-100'}`}>{saved ? <Check size={18} /> : <Plus size={18} />}</button>
                  </article>;
                })}
              </div>}
              {results.length > visibleCount && <button type="button" onClick={() => setVisibleCount((count) => count + 60)} className="mt-3 min-h-11 w-full text-sm font-medium text-accent-500">더 보기 ({(results.length - visibleCount).toLocaleString()}권)</button>}
            </section>
          </>}
          {tab === 'annotations' && <div className="space-y-4"><h2 className="text-xl font-semibold">내 주석</h2><LibraryAnnotations ownerKey={ownerKey} books={books} themeVariables={themeVariables} /></div>}
          {tab === 'statistics' && <LibraryReadingStatisticsModal embedded open visible ownerKey={ownerKey} theme={theme} themeVariables={themeVariables} accentColor={props.accentColor} syncHealth={props.syncHealth} quarantinedDocumentCount={props.quarantinedDocumentCount} canRefresh={props.canRefresh} refreshing={props.refreshing} lastServerCheckedAt={props.lastServerCheckedAt} onRefresh={props.onRefresh} onClose={() => navigate('overview')} />}
          </>}
        </main>
      </div>
    </div>
  );
}
