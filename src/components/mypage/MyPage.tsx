'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ArrowLeft, BookCopy, BookOpen, BookOpenCheck, Check, Compass, Heart, Highlighter, LayoutDashboard, Library, Plus, Search, ChartNoAxesColumn, Settings2, Star } from 'lucide-react';
import type { Book, ThemeClasses, UserProgress } from '../../types';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { groupDiscoveryBooks, loadBookDiscovery, type DiscoveryBook } from '../../lib/bookDiscovery';
import { bookDetailHref, readBookDetailId } from '../../lib/bookDetail';
import { platformWorkKey, type ReadBook } from '../../lib/readBooks';
import { useAccountWishlist } from '../../hooks/useAccountWishlist';
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

type Tab = 'overview' | 'wishlist' | 'read' | 'discover' | 'statistics' | 'annotations' | 'browse' | 'sharing' | 'reviews';
const tabs = [
  { id: 'overview', label: '대시보드', icon: LayoutDashboard },
  { id: 'wishlist', label: '위시리스트', icon: Heart },
  { id: 'read', label: '읽은 책', icon: BookOpenCheck },
  { id: 'discover', label: '도서목록', icon: BookCopy },
  { id: 'statistics', label: '독서 통계', icon: ChartNoAxesColumn },
  { id: 'annotations', label: '주석', icon: Highlighter },
  { id: 'browse', label: '둘러보기', icon: Compass },
  { id: 'reviews', label: '내 평가', icon: Star },
  { id: 'sharing', label: '공개 설정', icon: Settings2 },
] as const;
const headerActions = [
  { id: 'search', label: '메타데이터 검색', icon: Search },
  { id: 'shelf', label: '내 서재', icon: Library },
  { id: 'sharing', label: '공개 설정', icon: Settings2 },
] as const;
const readTab = (): Tab => {
  if (typeof window === 'undefined') return 'overview';
  const candidate = readBookDetailId(window.location.hash)
    ? window.history.state?.myPageBookFrom ?? 'discover'
    : window.location.hash.split('/')[1];
  return candidate === 'people' ? 'browse' : tabs.find(({ id }) => id === candidate)?.id ?? 'overview';
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
  const [compactMenu, setCompactMenu] = useState(false);
  const titleRow = useRef<HTMLElement>(null);
  const menu = useRef<HTMLElement>(null);
  const catalogSearch = useRef<HTMLInputElement>(null);
  const [openedBook, setOpenedBook] = useState<DiscoveryBook | ReadBook>();
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
  useLayoutEffect(() => {
    const header = titleRow.current;
    if (!header) return;
    let compact = false;
    const update = () => {
      const next = titleMiddleY(header) <= 0;
      if (compact === next) return;
      compact = next;
      setCompactMenu(next);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, []);
  useEffect(() => {
    const nav = menu.current;
    const selected = nav?.querySelector('[aria-current="page"]');
    if (!compactMenu || !nav || !selected) return;
    const keepSelectedVisible = () => {
      const { left, right } = nav.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      if (selectedBounds.left < left) nav.scrollLeft += selectedBounds.left - left;
      else if (selectedBounds.right > right) nav.scrollLeft += selectedBounds.right - right;
    };
    keepSelectedVisible();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(keepSelectedVisible);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [compactMenu, tab]);
  const navigate = (next: Tab) => {
    if (next === tab && !bookId) return;
    readListScroll.current = null;
    window.history.pushState(null, '', `#mypage/${next}`);
    setTab(next);
    setBookId(null);
    const titleMiddle = titleRow.current ? titleMiddleY(titleRow.current) : undefined;
    if (titleMiddle !== undefined && titleMiddle < 0) {
      window.scrollTo({ top: Math.ceil(window.scrollY + titleMiddle), behavior: 'instant' });
    }
  };
  const openBookById = (id: string, book?: DiscoveryBook | ReadBook) => {
    if (tab === 'read') readListScroll.current = window.scrollY;
    window.history.pushState({ ...window.history.state, myPageBookFrom: tab }, '', bookDetailHref(id));
    setOpenedBook(book);
    setBookId(id);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const openBook = (book: DiscoveryBook | ReadBook) => openBookById(book.id, book);
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
  const matchingSource = openedBook?.id === bookId ? openedBook : undefined;
  const readSource = matchingSource && !('platforms' in matchingSource) ? matchingSource : undefined;
  const discoverySource = matchingSource && 'platforms' in matchingSource ? matchingSource : undefined;
  const groupedCatalog = useMemo(() => catalog ? groupDiscoveryBooks(catalog) : null, [catalog]);
  const searchableTitles = useMemo(() => {
    const titles = new Map<string, string[]>();
    for (const item of catalog ?? []) {
      const id = groupedCatalog?.byId.get(item.id)?.id ?? item.id;
      const values = titles.get(id) ?? [];
      values.push(item.title.normalize('NFC').toLocaleLowerCase());
      titles.set(id, values);
    }
    return titles;
  }, [catalog, groupedCatalog]);
  const detailBook = useMemo(() => {
    if (!bookId) return undefined;
    return groupedCatalog?.byId.get(bookId)
      ?? discoverySource
      ?? wishlist.entries.find(({ book }) => book.id === bookId)?.book
      ?? groupedCatalog?.books.find((book) => readSource?.equivalentTitleKeys?.includes(book.id)
        || book.platforms.some(({ id, url }) => readSource?.platformWorkKeys?.includes(platformWorkKey(id, url))));
  }, [bookId, groupedCatalog, discoverySource, readSource, wishlist.entries]);
  const detailSaved = bookId !== null && (
    wishlist.savedIds.has(bookId)
    || (detailBook !== undefined && wishlist.savedIds.has(detailBook.id))
    || (readSource !== undefined && wishlist.entries.some(({ book }) => readSource.equivalentTitleKeys?.includes(book.id)
      || book.platforms.some(({ id, url }) => readSource.platformWorkKeys?.includes(JSON.stringify([id, url])))))
  );
  const needsCatalog = Boolean(bookId) || tab === 'discover';
  useEffect(() => {
    if (!needsCatalog || catalog) return;
    let active = true;
    void loadBookDiscovery().then((result) => {
      if (active) { setCatalog(result); setCatalogError(false); }
    }).catch(() => { if (active) setCatalogError(true); });
    return () => { active = false; };
  }, [catalog, needsCatalog, retry]);
  const list = useMemo(() => tab === 'wishlist'
    ? wishlist.entries.map((entry) => entry.book) : groupedCatalog?.books ?? [], [groupedCatalog, tab, wishlist.entries]);
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
  const openCatalogSearch = () => {
    // Keep focus in the click event so mobile browsers can open the keyboard.
    if (tab !== 'discover' || bookId) flushSync(() => openTab('discover'));
    catalogSearch.current?.focus({ preventScroll: true });
    catalogSearch.current?.scrollIntoView({ block: 'nearest' });
  };
  const detail = tabs.find(({ id }) => id === tab)!;
  const browse = tab === 'discover' || tab === 'wishlist';
  const loading = tab === 'discover' ? !catalog && !catalogError : wishlist.loading;
  const headerActionPosition = compactMenu ? '' : 'translate-y-[calc(-1.625rem_-_var(--mypage-title-height)/2)]';
  const headerActionMotion = 'motion-safe:transition-[translate,background-color] motion-safe:duration-200';

  return (
    <div data-my-page="true" className="min-h-dvh [--mypage-title-height:5rem] [--mypage-title-half:calc(var(--mypage-title-height)/2)] sm:[--mypage-title-height:6rem]" style={{ ...themeVariables, backgroundColor: 'var(--viewer-theme-bg)', color: 'var(--viewer-theme-text)' }}>
      <header ref={titleRow}>
        <div className="mx-auto flex h-[var(--mypage-title-height)] max-w-5xl items-center pl-[4.5rem] pr-36 sm:pl-[5.25rem] sm:pr-40">
          <h1 className="text-[clamp(1rem,4.6vw,1.25rem)] font-semibold tracking-tight sm:text-2xl">{bookId ? '도서 상세정보' : '마이페이지'}</h1>
        </div>
      </header>
      <div className="pointer-events-none sticky top-0 z-30 -mt-[var(--mypage-title-half)] pt-[var(--mypage-title-half)]">
        <div data-mypage-menu={compactMenu ? 'compact' : 'expanded'}
          className={`pointer-events-auto bg-[var(--viewer-theme-bg)] motion-safe:transition-[translate] motion-safe:duration-200 ${compactMenu ? '-translate-y-[var(--mypage-title-half)]' : ''}`}>
          <div className="relative mx-auto max-w-5xl px-5 py-1 sm:px-8">
            <button type="button" onClick={bookId ? closeBook : onBack} aria-label={bookId ? '도서 목록으로 돌아가기' : '서재로 돌아가기'}
              className={`absolute left-5 top-1 flex size-11 items-center justify-center rounded-full hover:bg-[color-mix(in_srgb,currentColor_6%,transparent)] sm:left-8 ${headerActionMotion} ${headerActionPosition}`}>
              <ArrowLeft size={19} />
            </button>
            <div className={`absolute right-5 top-1 z-10 sm:right-8 ${headerActionMotion} ${headerActionPosition}`}>
              <div role="group" aria-label="마이페이지 바로가기" className="shelf-mobile-header-pill flex h-11 items-center gap-0.5 px-1">
                {headerActions.map(({ id, label, icon: Icon }) => (
                  <button key={id} type="button" aria-label={label} title={label} aria-current={tab === id ? 'page' : undefined}
                    onClick={id === 'search' ? openCatalogSearch : id === 'shelf' ? onBack : () => openTab(id)}
                    className={`flex size-9 items-center justify-center rounded-full transition-colors hover:bg-current/10 hover:opacity-100 ${tab === id ? 'text-accent-500' : 'opacity-70'}`}>
                    <Icon size={19} aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
            <nav ref={menu} aria-label="마이페이지 메뉴" className={`flex gap-1 overflow-x-auto [scrollbar-width:none] motion-safe:transition-[margin] motion-safe:duration-200 [&::-webkit-scrollbar]:hidden ${compactMenu ? 'ml-12 mr-32' : ''}`}>
              {tabs.filter(({ id }) => id !== 'sharing' && (signedIn || id !== 'reviews')).map(({ id, label, icon: Icon }) => {
                const selected = tab === id;
                const iconOnly = compactMenu && !selected;
                const size = iconOnly ? 'w-11' : compactMenu ? 'gap-1.5 whitespace-nowrap px-2 text-xs sm:gap-2 sm:px-3 sm:text-sm' : 'gap-2.5 px-3 text-sm';
                return (
                  <button key={id} type="button" onClick={() => openTab(id)} title={iconOnly ? label : undefined}
                    aria-current={selected ? 'page' : undefined}
                    className={`flex min-h-11 shrink-0 items-center justify-center rounded-xl transition-colors ${size} ${selected ? 'bg-[color-mix(in_srgb,var(--accent-500)_10%,transparent)] font-semibold text-accent-500' : 'opacity-60 hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] hover:opacity-100'}`}>
                    <Icon size={compactMenu ? 19 : 17} aria-hidden="true" />
                    <span className={iconOnly ? 'sr-only' : undefined}>{label}</span>
                    {!compactMenu && id === 'wishlist' && wishlist.entries.length > 0 && <span className="ml-auto pl-2 text-xs tabular-nums">{wishlist.entries.length}</span>}
                  </button>
                );
              })}
            </nav>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-5 pb-14 pt-6 sm:px-8 sm:pt-8">
        <main className="min-w-0 space-y-4 sm:space-y-6" aria-label={bookId ? '도서 상세정보' : detail.label}>
          {tab === 'read' && <div hidden={Boolean(bookId)}><ReadBooks key={ownerKey} ownerKey={ownerKey} onOpenBook={openBook} accountStorage={signedIn} /></div>}
          {tab === 'browse' && <div hidden={Boolean(bookId)}><PublicBrowse key={ownerKey} owner={ownerKey} onOpenBook={openBookById} /></div>}
          {tab === 'overview' && <div hidden={Boolean(bookId)} className="space-y-8 sm:space-y-10">
            <DashboardBookRow title="읽고 싶은 도서" books={wishlist.entries.map(({ book }) => book)}
              onOpenBook={openBook} onShowAll={() => openTab('wishlist')}>
              {wishlist.loading ? <p role="status" className="text-sm opacity-60">위시리스트를 불러오는 중…</p>
                : !wishlist.error && wishlist.entries.length === 0 && <div className="flex flex-wrap items-center gap-x-4">
                  <p className="text-sm opacity-60">담아둔 책이 없습니다.</p>
                  <button type="button" onClick={() => openTab('discover')} className="flex min-h-10 items-center gap-1.5 text-xs font-semibold text-accent-500"><Plus size={16} />도서 찾아보기</button>
                </div>}
            </DashboardBookRow>
            <ReadBooks key={`read:${ownerKey}`} ownerKey={ownerKey} onShowAll={() => openTab('read')} onOpenBook={openBook} />
            <MyReviews key={`reviews:${ownerKey}`} owner={ownerKey} onShowAll={() => openTab('reviews')} onOpenBook={openBookById} />
            <ReadingDashboard ownerKey={ownerKey} onOpenStatistics={() => openTab('statistics')} onOpenAnnotations={() => openTab('annotations')} />
          </div>}
          {bookId ? (
            <BookDetail key={`${ownerKey}:${bookId}`} bookId={bookId} discovery={detailBook} readBook={readSource} ownerKey={ownerKey} books={books} progress={progress} bookmarkProgress={bookmarkProgress} catalogLoading={!catalog && !catalogError && !detailBook} saved={detailSaved} />
          ) : <>
          {wishlist.error && <p role="alert" className="text-sm text-accent-500">{wishlist.error} {signedIn && <button type="button" onClick={() => void wishlist.refresh()} className="underline">위시리스트 다시 불러오기</button>}</p>}
          {tab === 'reviews' && (signedIn ? <MyReviews key={ownerKey} owner={ownerKey} onOpenBook={openBookById} />
            : <p className="mypage-section text-sm">내 평가는 로그인 후 이용할 수 있습니다.</p>)}
          {tab === 'sharing' && (signedIn
            ? <MyPageSharingSettings key={ownerKey} owner={ownerKey} onWishlistImported={() => void wishlist.refresh()} />
            : <p className="mypage-section text-sm">공개 설정은 로그인 후 이용할 수 있습니다.</p>)}
          {browse && <>
            <div className="flex items-end justify-between gap-3"><div><h2 className="text-xl font-semibold">{detail.label}</h2><p className="mt-1.5 text-xs opacity-45">{tab === 'wishlist' ? `담아둔 책 ${wishlist.entries.length.toLocaleString()}권` : groupedCatalog ? `공개 메타데이터 ${groupedCatalog.books.length.toLocaleString()}권` : '공개 메타데이터에서 읽고 싶은 책을 찾아보세요.'}</p></div>{tab === 'wishlist' && <button type="button" onClick={() => openTab('discover')} className="flex min-h-10 items-center gap-1.5 rounded-full bg-accent-500 px-4 text-xs font-semibold text-white"><Plus size={15} />추가</button>}</div>
            <section aria-label="도서 검색 및 필터" className="space-y-2.5">
              <label className="flex items-center gap-2.5 rounded-lg px-3 ring-1 ring-inset ring-current/15 focus-within:outline-2 focus-within:outline-accent-500"><Search size={17} className="shrink-0 opacity-60" /><input ref={tab === 'discover' ? catalogSearch : undefined} aria-label="도서 제목 검색" value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(60); }} placeholder="도서 제목 검색" className="min-h-10 min-w-0 flex-1 scroll-mt-16 bg-transparent text-sm outline-none" /></label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <select aria-label="도서 플랫폼 필터" value={source} onChange={(event) => { setSource(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 플랫폼</option><option value="series">네이버 시리즈</option><option value="kakao">카카오페이지</option><option value="novelpia">노벨피아</option></select>
                <select aria-label="도서 장르 필터" value={genre} onChange={(event) => { setGenre(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 장르</option>{genres.map((name) => <option key={name}>{name}</option>)}</select>
                <select aria-label="도서 태그 필터" value={tag} onChange={(event) => { setTag(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 태그</option>{tags.map((name) => <option key={name}>{name}</option>)}</select>
                <select aria-label="도서 정렬" value={sort} onChange={(event) => setSort(event.target.value)} className={inputClass}><option value="popular">인기순</option><option value="views">조회·다운로드순</option><option value="title">가나다순</option>{tab === 'wishlist' && <option value="saved">담은 순</option>}</select>
              </div>
            </section>
            <section aria-label="도서 목록">
              {loading ? <div role="status" className="py-10 text-center text-sm opacity-65">{tab === 'discover' ? '도서 정보를 불러오는 중…' : '위시리스트를 불러오는 중…'}</div>
              : tab === 'discover' && catalogError ? <div role="alert" className="py-8 text-center"><p className="text-sm opacity-70">도서 정보를 불러오지 못했습니다.</p><button type="button" onClick={() => { setCatalogError(false); setRetry((value) => value + 1); }} className="mt-3 min-h-10 px-3 text-sm font-medium text-accent-500">다시 시도</button></div>
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
