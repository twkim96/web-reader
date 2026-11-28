'use client';

import type { SharedDriveConnection } from './SharedDriveImport';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Archive, AtSign, BookCopy, BookOpen, ChartNoAxesColumn, Check, Cloud, Compass, Hash, House, Library, LockKeyhole, Plus, Search, Settings2, X } from 'lucide-react';
import type { Book, ThemeClasses, UserProgress } from '../../types';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { getDiscoveryAuthorBooks, getGroupedBookDiscovery, loadBookDiscovery, resolveReadBookDiscovery, searchDiscoveryAuthors, type DiscoveryBook } from '../../lib/bookDiscovery';
import { bookDetailHref, hasBookReviewTarget, readBookDetailId } from '../../lib/bookDetail';
import { finishDiscoveryTiming, startDiscoveryTiming } from '../../lib/myPagePerformance';
import type { ReadBook } from '../../lib/readBooks';
import type { MyPageBrowseSection } from '../../lib/myPageSocial';
import type { PublicBookCatalogTag } from '../../lib/publicBookCatalogSchema';
import { useAccountWishlist } from '../../hooks/useAccountWishlist';
import { useMouseDragScroll } from '../../hooks/useMouseDragScroll';
import { useMyPageReviews } from '../../hooks/useMyPageReviews';
import { useMyPageSort } from '../../hooks/useMyPageSort';
import { ReadingDashboard } from './ReadingDashboard';
import { AdminSettingsLink } from './AdminSettingsLink';
import { ReadBooks } from './ReadBooks';
import { createRecommendationRanker, RecommendedBooks } from './RecommendedBooks';
import { BookCover } from './BookCover';
import { BookDetail } from './BookDetail';
import { BookDetailLink } from './BookDetailLink';
import { DashboardBookRow } from './DashboardBookRow';
import { MyPageSharingSettings } from './SocialPanels';
import { PublicBrowse } from './PublicBrowse';
import { MyReviews } from './MyReviews';
import { ListSort } from './ListSort';
import { LibraryAnnotations } from '../LibraryAnnotations';
import { LibraryReadingStatisticsModal } from '../LibraryReadingStatisticsModal';
import { normalizeShelfTagQuery, searchPublicBookCatalogTags } from '../shelf/tagSearch';
import type { SyncHealth } from '../../lib/syncHealth';
import { useBookTitleDisplay } from '../../contexts/BookTitleDisplayContext';

const tabLabels = {
  overview: '대시보드',
  recommendations: '추천 도서',
  discover: '도서목록',
  browse: '피드',
  read: '읽은 책',
  wishlist: '위시리스트',
  reviews: '내 평가',
  calendar: '캘린더',
  statistics: '통계',
  annotations: '주석',
  sharing: '마이페이지 설정',
} as const;

type Tab = keyof typeof tabLabels;
const primaryMenu = [
  { label: '홈', icon: House, tabs: ['overview'] },
  { label: '도서', icon: BookCopy, tabs: ['discover'] },
  { label: '피드', icon: Compass, tabs: ['browse'] },
  { label: '보관', icon: Archive, tabs: ['read', 'wishlist', 'reviews'] },
  { label: '기록', icon: ChartNoAxesColumn, tabs: ['calendar', 'statistics', 'annotations'] },
] satisfies readonly { label: string; icon: typeof House; tabs: readonly [Tab, ...Tab[]] }[];
const feedTabs = [
  { id: 'reviews', label: '평점을 남긴 도서' },
  { id: 'wishlist', label: '위시리스트' },
] as const;
const catalogSorts = [
  ['popular', '인기순'],
  ['views', '조회·다운로드순'],
  ['title', '가나다순'],
] as const;
const wishlistSorts = [['saved', '최근 담은 순'], ...catalogSorts] as const;
const recommendationSorts = [['recommended', '추천순'], ...catalogSorts] as const;
type CatalogSort = typeof catalogSorts[number][0];
const bookOrder: Record<CatalogSort, (a: DiscoveryBook, b: DiscoveryBook) => number> = {
  title: (a, b) => a.title.localeCompare(b.title, 'ko'),
  popular: (a, b) => (b.popularity ?? -1) - (a.popularity ?? -1) || a.title.localeCompare(b.title, 'ko'),
  views: (a, b) => (b.sourceCount ?? -1) - (a.sourceCount ?? -1) || a.title.localeCompare(b.title, 'ko'),
};
const sourceCountFormat = new Intl.NumberFormat('ko', { notation: 'compact', maximumFractionDigits: 1 });
type DiscoveryList = {
  searchableTitles: ReadonlyMap<string, readonly string[]>;
  genres: readonly string[];
  tags: readonly string[];
  catalogTags: readonly PublicBookCatalogTag[];
  books: readonly DiscoveryBook[];
};
const discoveryListCache = new WeakMap<readonly DiscoveryBook[], Map<CatalogSort, DiscoveryList>>();
const SUGGESTION_PAGE_SIZE = 40;

function DiscoverySuggestions({ suggestions, tagMode, onSelect }: {
  suggestions: readonly { label: string; titleCount: number }[];
  tagMode: boolean;
  onSelect: (label: string) => void;
}) {
  const [visibleCount, setVisibleCount] = useState(SUGGESTION_PAGE_SIZE);
  const suggestionDrag = useMouseDragScroll();
  const hasMore = visibleCount < suggestions.length;
  const showMore = () => setVisibleCount((count) => Math.min(count + SUGGESTION_PAGE_SIZE, suggestions.length));
  return (
    <div role="group" aria-label={tagMode ? '태그 자동완성' : '작가 자동완성'} {...suggestionDrag}
      onScroll={(event) => {
        const { scrollWidth, scrollLeft, clientWidth } = event.currentTarget;
        if (hasMore && scrollWidth - scrollLeft <= clientWidth * 2) showMore();
      }}
      className="flex max-w-full gap-1.5 overflow-x-auto overscroll-x-contain pb-1 data-[mouse-dragging=true]:cursor-grabbing data-[mouse-dragging=true]:select-none">
      {suggestions.slice(0, visibleCount).map(({ label, titleCount }) => (
        <button key={label} type="button" onClick={() => onSelect(label)}
          className="min-h-8 shrink-0 whitespace-nowrap rounded-md bg-current/5 px-2.5 text-xs font-semibold ring-1 ring-inset ring-current/15 hover:text-accent-500">
          {tagMode ? '#' : '@'}{label} <span className="opacity-55">{titleCount.toLocaleString('ko-KR')}권</span>
        </button>
      ))}
      {hasMore && (
        <button type="button" onClick={showMore} aria-label="자동완성 더 보기"
          className="min-h-8 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-semibold text-accent-500">더 보기</button>
      )}
    </div>
  );
}

function getDiscoveryList(rows: readonly DiscoveryBook[], sort: CatalogSort): DiscoveryList {
  let sorts = discoveryListCache.get(rows);
  if (!sorts) {
    sorts = new Map();
    discoveryListCache.set(rows, sorts);
  }
  const cached = sorts.get(sort);
  if (cached) return cached;

  const grouped = getGroupedBookDiscovery(rows);
  const base = sorts.values().next().value ?? (() => {
    const started = startDiscoveryTiming();
    const searchableTitles = new Map<string, string[]>();
    for (const item of rows) {
      const id = grouped.byId.get(item.id)?.id ?? item.id;
      const titles = searchableTitles.get(id) ?? [];
      titles.push(item.title.normalize('NFC').toLocaleLowerCase());
      if (item.author) titles.push(item.author.normalize('NFC').toLocaleLowerCase());
      searchableTitles.set(id, titles);
    }
    const genres = new Set<string>();
    const counts = new Map<string, number>();
    for (const book of grouped.books) {
      if (book.genre) genres.add(book.genre);
      for (const name of book.tags) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const tags = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 120)
      .map(([name]) => name).sort((a, b) => a.localeCompare(b, 'ko'));
    const catalogTags = [...counts].map(([label, titleCount], id) => ({ id, label, titleCount }));
    finishDiscoveryTiming('search', started);
    return { searchableTitles, genres: [...genres].sort(), tags, catalogTags };
  })();
  const started = startDiscoveryTiming();
  const list = { ...base, books: [...grouped.books].sort(bookOrder[sort]) };
  finishDiscoveryTiming('sort', started);
  sorts.set(sort, list);
  return list;
}

const desktopQuery = '(min-width: 640px)';
const headerActions = [
  { id: 'shelf', label: '내 서재', icon: Library },
  { id: 'sharing', label: tabLabels.sharing, icon: Settings2 },
] as const;
const readTab = (): Tab => {
  if (typeof window === 'undefined') return 'overview';
  const candidate = readBookDetailId(window.location.hash)
    ? window.history.state?.myPageBookFrom ?? 'discover'
    : window.location.hash.split('?')[0].split('/')[1];
  if (candidate === 'people') return 'browse';
  return typeof candidate === 'string' && Object.hasOwn(tabLabels, candidate) ? candidate as Tab : 'overview';
};
const readDetailId = () => typeof window === 'undefined' ? null : readBookDetailId(window.location.hash);
const readDiscoveryPreset = () => {
  if (typeof window === 'undefined') return '';
  if (readDetailId()) {
    const preset = window.history.state?.myPageDiscoveryPreset;
    return typeof preset === 'string' ? preset : '';
  }
  const [path, params] = window.location.hash.split('?');
  return path === '#mypage/discover' ? new URLSearchParams(params).get('q') ?? '' : '';
};
type DiscoverySearch = { query: string; exactAuthor: boolean; source: string; genre: string; selectedTags: string[]; visibleCount: number };
const emptyDiscoverySearch = (query: string): DiscoverySearch => ({
  query, exactAuthor: query.startsWith('@'), source: '', genre: '', selectedTags: [], visibleCount: 60,
});
const readSavedDiscoverySearch = (ownerKey: OwnerKey): DiscoverySearch | undefined => {
  if (typeof window === 'undefined') return;
  const entry = window.history.state?.myPageDiscoverySearch;
  if (entry?.ownerKey === ownerKey) return entry.search;
};
const inputClass = 'min-h-11 min-w-0 rounded-lg px-3 ring-1 ring-inset ring-current/15 text-sm focus-visible:outline-2 focus-visible:outline-accent-500';
const titleMiddleY = (header: HTMLElement) => {
  const { top, height } = header.getBoundingClientRect();
  return top + height / 2;
};

type Props = {
  ownerKey: OwnerKey;
  driveConnected: boolean;
  onConnect: () => void;
  sharedDrive?: SharedDriveConnection;
  onSharedDriveReconnect?: () => void;
  books: Book[];
  progress: Record<string, UserProgress>;
  bookmarkProgress: Record<string, UserProgress>;
  onOpenDeviceBook: (book: Book) => void;
  theme: ThemeClasses;
  themeVariables: React.CSSProperties;
  accentColor: string;
  syncHealth: SyncHealth;
  quarantinedDocumentCount: number;
  canRefresh: boolean;
  refreshing: boolean;
  lastServerCheckedAt: number | null;
  showRecommendedBooks: boolean;
  onShowRecommendedBooksChange: (visible: boolean) => void;
  onRefresh: () => void;
  onBack: () => void;
};

export function MyPage(props: Props) {
  const { ownerKey, books, progress, bookmarkProgress, theme, themeVariables, onBack } = props;
  const [tab, setTab] = useState<Tab>(readTab);
  const [feedSection, setFeedSection] = useState<MyPageBrowseSection>('reviews');
  const [bookId, setBookId] = useState(readDetailId);
  const [focusReview, setFocusReview] = useState(() => typeof window !== 'undefined' && hasBookReviewTarget(window.location.hash));
  const [compactMenu, setCompactMenu] = useState(false);
  const titleRow = useRef<HTMLElement>(null);
  const [openedBook, setOpenedBook] = useState<{ id: string; book: DiscoveryBook | ReadBook }>();
  const readListScroll = useRef<number | null>(null);
  const discoveryStarted = useRef<number | undefined>(undefined);
  const restoreReadListScroll = useRef(false);
  const [catalog, setCatalog] = useState<DiscoveryBook[] | null>(null);
  const [recommendationSeed] = useState(() => Math.floor(Math.random() * 0x1_0000_0000));
  const [recommended, setRecommended] = useState<{ ownerKey: OwnerKey; catalog: readonly DiscoveryBook[]; books: readonly DiscoveryBook[] }>();
  const [catalogError, setCatalogError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [initialSearch] = useState(() => readSavedDiscoverySearch(ownerKey) ?? emptyDiscoverySearch(readDiscoveryPreset()));
  const [query, setQuery] = useState(initialSearch.query);
  const discoveryPreset = useRef(readDiscoveryPreset());
  const [exactAuthor, setExactAuthor] = useState(initialSearch.exactAuthor);
  const [source, setSource] = useState(initialSearch.source);
  const [genre, setGenre] = useState(initialSearch.genre);
  const [selectedTags, setSelectedTags] = useState(initialSearch.selectedTags);
  const discoverySearchRef = useRef<HTMLInputElement>(null);
  const [wishlistSort, setWishlistSort] = useMyPageSort(ownerKey, 'wishlist', wishlistSorts, 'saved');
  const [discoverySort, setDiscoverySort] = useMyPageSort(ownerKey, 'discover', catalogSorts, 'popular');
  const [recommendationSort, setRecommendationSort] = useMyPageSort(ownerKey, 'recommendations', recommendationSorts, 'recommended');
  const [visibleCount, setVisibleCount] = useState(initialSearch.visibleCount);
  const signedIn = !isGuestOwner(ownerKey);
  const discovering = tab === 'discover';
  const showOverview = tab === 'overview';
  const showRecommendationList = tab === 'recommendations';
  const needsWishlist = Boolean(bookId) || showOverview || discovering || tab === 'wishlist'
    || (showRecommendationList && props.showRecommendedBooks);
  const showDeviceReadBooks = !signedIn && !bookId && (showOverview || tab === 'read');
  const formatBookTitle = useBookTitleDisplay();
  const deviceReadBooks = useMemo(() => {
    if (!showDeviceReadBooks) return [];
    return books.flatMap((book) => {
      const position = bookmarkProgress[book.id];
      if (!position?.lastRead || (!position.cfi && !position.anchorCfi && position.progressPercent <= 0)) return [];
      return [{ id: book.id, book, title: formatBookTitle(book.name), coverUrl: null, position }];
    }).sort((a, b) => b.position.lastRead - a.position.lastRead);
  }, [books, bookmarkProgress, formatBookTitle, showDeviceReadBooks]);
  const wishlist = useAccountWishlist(ownerKey, needsWishlist);
  const { entries: wishlistEntries, loading: wishlistLoading } = wishlist;
  const dashboardWishlist = useMemo(() => wishlistLoading ? undefined : wishlistEntries.map(({ book }) => book), [wishlistEntries, wishlistLoading]);
  const groupedCatalog = catalog ? getGroupedBookDiscovery(catalog) : null;
  const recommendationRanker = useMemo(() => catalog ? { ownerKey, rank: createRecommendationRanker(catalog, recommendationSeed) } : null,
    [catalog, ownerKey, recommendationSeed]);
  const previousRecommendations = recommended?.ownerKey === ownerKey && recommended.catalog === catalog ? recommended.books : undefined;
  const keepRecommendations = !bookId && (previousRecommendations?.some(({ id }) => wishlist.savedIds.has(id)
    || groupedCatalog?.equivalents.get(id)?.some((alias) => wishlist.savedIds.has(alias))) ?? false);
  const rememberRecommendations = useCallback((books: readonly DiscoveryBook[]) => {
    if (catalog) setRecommended({ ownerKey, catalog, books });
  }, [catalog, ownerKey]);
  const readBookDetailId = (book: ReadBook) =>
    groupedCatalog && book.platformWorkKeys?.length ? resolveReadBookDiscovery(groupedCatalog, book).book?.id ?? null : null;
  const reviews = useMyPageReviews(ownerKey, signedIn && tab === 'read' && !bookId);
  useLayoutEffect(() => {
    const header = titleRow.current;
    if (!header) return;
    const desktop = window.matchMedia?.(desktopQuery);
    let compact = false;
    const update = () => {
      const wide = desktop?.matches ?? true;
      const next = wide && titleMiddleY(header) <= 0;
      if (compact !== next) {
        compact = next;
        setCompactMenu(next);
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
  const applyDiscoverySearch = useCallback((search: DiscoverySearch) => {
    setQuery(search.query);
    setExactAuthor(search.exactAuthor);
    setSource(search.source);
    setGenre(search.genre);
    setSelectedTags(search.selectedTags);
    setVisibleCount(search.visibleCount);
  }, []);
  const currentDiscoverySearch = { query, exactAuthor, source, genre, selectedTags, visibleCount };
  const saveDiscoverySearch = () => {
    if (tab !== 'discover') return;
    window.history.replaceState({
      ...window.history.state, myPageDiscoverySearch: { ownerKey, search: currentDiscoverySearch },
    }, '', window.location.href);
  };
  const navigate = (next: Tab, preset = '', nextSearch?: DiscoverySearch) => {
    if (next === tab && !bookId && preset === discoveryPreset.current) {
      if (nextSearch) {
        window.history.replaceState({
          ...window.history.state, myPageDiscoverySearch: { ownerKey, search: nextSearch },
        }, '', window.location.href);
      }
      return;
    }
    saveDiscoverySearch();
    if (next === 'discover') discoveryStarted.current = startDiscoveryTiming();
    readListScroll.current = null;
    discoveryPreset.current = preset;
    window.history.pushState(
      nextSearch ? { myPageDiscoverySearch: { ownerKey, search: nextSearch } }
        : next === 'recommendations' && tab === 'overview' ? { myPageRecommendationsFromHome: true } : null,
      '', `#mypage/${next}${preset ? `?q=${encodeURIComponent(preset)}` : ''}`,
    );
    setTab(next);
    if (next !== 'browse') setFeedSection('reviews');
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
    if (tab === 'read' && !bookId) readListScroll.current = window.scrollY;
    saveDiscoverySearch();
    window.history.pushState({
      ...window.history.state, myPageBookFrom: tab, myPageDiscoveryPreset: discoveryPreset.current,
    }, '', bookDetailHref(id, reviewTarget));
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
      const preset = readDiscoveryPreset();
      if (nextTab === 'discover' || discoveryPreset.current !== preset) {
        applyDiscoverySearch(readSavedDiscoverySearch(ownerKey) ?? emptyDiscoverySearch(preset));
      }
      discoveryPreset.current = preset;
      restoreReadListScroll.current = nextTab === 'read' && nextBook === null;
      setTab(nextTab);
      if (nextTab !== 'browse') setFeedSection('reviews');
      setBookId(nextBook);
      setFocusReview(hasBookReviewTarget(window.location.hash));
    };
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
    };
  }, [applyDiscoverySearch, ownerKey]);
  useLayoutEffect(() => {
    if (!restoreReadListScroll.current || bookId || tab !== 'read') return;
    restoreReadListScroll.current = false;
    if (readListScroll.current !== null) window.scrollTo({ top: readListScroll.current, behavior: 'instant' });
  }, [bookId, tab]);
  const matchingSource = openedBook?.id === bookId ? openedBook?.book : undefined;
  const readSource = matchingSource && !('platforms' in matchingSource) ? matchingSource : undefined;
  const discoverySource = matchingSource && 'platforms' in matchingSource ? matchingSource : undefined;
  const browse = discovering || tab === 'wishlist';
  const readMatch = readSource && groupedCatalog ? resolveReadBookDiscovery(groupedCatalog, readSource) : undefined;
  const detailBook = !bookId ? undefined : readSource ? readMatch?.book : groupedCatalog?.byId.get(bookId)
    ?? discoverySource ?? wishlist.entries.find(({ book }) => book.id === bookId)?.book;
  const detailSaved = bookId !== null && !readMatch?.blocked
    && (wishlist.savedIds.has(bookId) || (detailBook !== undefined && wishlist.savedIds.has(detailBook.id)));
  const catalogLoading = !catalog && !catalogError;
  const hasTaggedWishlist = props.showRecommendedBooks && wishlistEntries.some(({ book }) => book.tags.length > 0);
  const needsCatalog = Boolean(bookId) || tab === 'discover' || (signedIn && tab === 'read')
    || (showOverview && (signedIn || hasTaggedWishlist)) || (showRecommendationList && props.showRecommendedBooks);
  useEffect(() => {
    if (!needsCatalog || catalog) return;
    let active = true;
    void loadBookDiscovery().then((result) => {
      if (active) { setCatalog(result); setCatalogError(false); }
    }).catch(() => { if (active) setCatalogError(true); });
    return () => { active = false; };
  }, [catalog, needsCatalog, retry]);
  const retryCatalog = () => { setCatalogError(false); setRetry((value) => value + 1); };
  const discoveryList = discovering && !bookId && catalog ? getDiscoveryList(catalog, discoverySort) : null;
  const discoveryBooks = discoveryList?.books;
  const genres = discoveryList?.genres ?? [];
  const tags = discoveryList?.tags ?? [];
  const tagMode = query.trim().startsWith('#');
  const tagQuery = tagMode ? normalizeShelfTagQuery(query.trim().slice(1)) : '';
  const authorMode = query.trim().startsWith('@');
  const authorQuery = authorMode ? query.trim().slice(1).trim() : '';
  const tagMatches = useMemo(() => {
    if (!tagMode || !discovering || bookId || !catalog) return [];
    const { catalogTags } = getDiscoveryList(catalog, discoverySort);
    return searchPublicBookCatalogTags(catalogTags, tagQuery, Infinity);
  }, [bookId, catalog, discovering, discoverySort, tagMode, tagQuery]);
  const availableTagSuggestions = tagMatches.filter(({ label }) => !selectedTags.includes(label));
  const tagSuggestions = tagQuery ? availableTagSuggestions : availableTagSuggestions.slice(0, 8);
  const authorMatches = useMemo(() => {
    if (exactAuthor || !authorQuery || !discovering || bookId || !catalog) return [];
    return searchDiscoveryAuthors(catalog, authorQuery);
  }, [authorQuery, bookId, catalog, discovering, exactAuthor]);
  const suggestions = tagMode ? tagSuggestions : authorMatches.slice(0, 24).map(({ label, books }) => ({
    label, titleCount: books.size,
  }));
  const discoveryResults = useMemo(() => {
    if (!discovering || bookId || !catalog) return [];
    const { books, searchableTitles } = getDiscoveryList(catalog, discoverySort);
    const normalized = authorMode ? authorQuery : query.trim().normalize('NFC').toLocaleLowerCase();
    if (!normalized && !source && !genre && !selectedTags.length) return books;
    const started = startDiscoveryTiming();
    const matchingTags = new Set(tagMatches.map(({ label }) => label));
    const authorBooks = authorQuery && exactAuthor
      ? getDiscoveryAuthorBooks(catalog, authorQuery)
      : new Set(authorMatches.flatMap((entry) => [...entry.books]));
    const matchesQuery = (book: DiscoveryBook) => {
      if (!normalized) return true;
      if (authorMode) return authorBooks?.has(book) ?? false;
      if (tagMode) return book.tags.some((name) => matchingTags.has(name));
      return (searchableTitles.get(book.id) ?? [book.title.normalize('NFC').toLocaleLowerCase()])
        .some((title) => title.includes(normalized));
    };
    const filtered = books.filter((book) => (
      matchesQuery(book)
      && (!source || book.platforms.some((platform) => platform.id === source))
      && (!genre || book.genre === genre)
      && selectedTags.every((name) => book.tags.includes(name))
    ));
    finishDiscoveryTiming('filter', started);
    return filtered;
  }, [authorMatches, authorMode, authorQuery, bookId, catalog, discovering, discoverySort, exactAuthor, genre, query, selectedTags, source, tagMode, tagMatches]);
  useLayoutEffect(() => {
    if (!discovering || bookId) {
      discoveryStarted.current = undefined;
    } else if (discoveryResults.length && discoveryStarted.current !== undefined) {
      finishDiscoveryTiming('first-rows', discoveryStarted.current);
      discoveryStarted.current = undefined;
    } else if (!catalog && discoveryStarted.current === undefined) {
      discoveryStarted.current = startDiscoveryTiming();
    }
  }, [bookId, catalog, discovering, discoveryResults.length]);
  const wishlistResults = useMemo(() => {
    if (tab !== 'wishlist' || bookId) return [];
    if (wishlistSort === 'saved') return [...wishlist.entries].sort((a, b) => b.addedAt - a.addedAt).map(({ book }) => book);
    return wishlist.entries.map(({ book }) => book).sort(bookOrder[wishlistSort]);
  }, [bookId, tab, wishlist.entries, wishlistSort]);
  const results = discovering ? discoveryResults : wishlistResults;
  const addTag = (name: string) => {
    if (!name) return;
    setSelectedTags((current) => current.includes(name) ? current : [...current, name]);
    if (tagMode) setQuery('');
    setVisibleCount(60);
    discoverySearchRef.current?.focus();
  };
  const removeTag = (name: string) => {
    setSelectedTags((current) => current.filter((tag) => tag !== name));
    setVisibleCount(60);
    discoverySearchRef.current?.focus();
  };
  const openTab = (next: Tab) => {
    const search = emptyDiscoverySearch('');
    applyDiscoverySearch(search);
    navigate(next, '', next === 'discover' ? search : undefined);
  };
  const openDiscoverySearch = (preset: string) => {
    applyDiscoverySearch(emptyDiscoverySearch(preset));
    navigate('discover', preset);
  };
  const selectSuggestion = (label: string) => {
    if (tagMode) {
      addTag(label);
      return;
    }
    const preset = `@${label}`;
    const search = { ...currentDiscoverySearch, query: preset, exactAuthor: true, visibleCount: 60 };
    applyDiscoverySearch(search);
    navigate('discover', preset, search);
    discoverySearchRef.current?.focus();
  };
  const detailLabel = tabLabels[tab];
  const activeGroup = primaryMenu.find(({ tabs }) => tabs.some((id) => id === (showRecommendationList ? 'overview' : tab)));
  const sectionTabs = tab === 'browse'
    ? feedTabs.map(({ id, label }) => ({ id, label, selected: feedSection === id, select: () => setFeedSection(id) }))
    : activeGroup && activeGroup.tabs.length > 1
      ? activeGroup.tabs.map((id) => ({ id, label: tabLabels[id], selected: tab === id, select: () => openTab(id) }))
      : [];
  const showSectionTabs = !bookId && sectionTabs.length > 0;
  const loading = tab === 'discover' ? !catalog && !catalogError : wishlist.loading;
  const headerActionPosition = compactMenu ? '' : 'translate-y-[calc(-1.625rem_-_var(--mypage-title-height)/2)]';
  const headerActionMotion = 'motion-safe:transition-[translate,background-color] motion-safe:duration-200';
  const headerButton = 'flex size-11 items-center justify-center rounded-full hover:bg-current/10';
  const showConnect = !signedIn || !props.driveConnected;
  const ConnectIcon = signedIn ? Cloud : LockKeyhole;
  const connectLabel = signedIn ? 'Google Drive 연결' : 'Google 계정으로 로그인';
  const title = bookId ? '도서 상세정보' : showRecommendationList ? tabLabels.recommendations : '마이페이지';
  const closeRecommendations = () => {
    if (window.history.state?.myPageRecommendationsFromHome) window.history.back();
    else openTab('overview');
  };
  const backButton = (
    <button type="button" onClick={bookId ? closeBook : showRecommendationList ? closeRecommendations : onBack}
      aria-label={bookId ? '도서 목록으로 돌아가기' : showRecommendationList ? '홈으로 돌아가기' : '서재로 돌아가기'}
      className={`${headerButton} transition-colors`}><ArrowLeft size={19} /></button>
  );
  const shortcuts = (
    <div role="group" aria-label="마이페이지 바로가기" className="flex">
      {showConnect && <button type="button" aria-label={connectLabel} title={connectLabel} onClick={props.onConnect}
        className={`${headerButton} transition-colors`}><ConnectIcon size={19} aria-hidden="true" /></button>}
      {headerActions.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" aria-label={label} title={label} aria-current={tab === id ? 'page' : undefined}
          onClick={id === 'shelf' ? onBack : () => openTab(id)}
          className={`${headerButton} transition-colors ${tab === id ? (compactMenu ? 'text-accent-500' : 'text-accent-500 sm:text-current') : ''}`}>
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
        onClick={() => openTab(selected && !showRecommendationList ? tab : firstTab)}
        className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap px-1 text-[11px] transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 sm:min-h-11 sm:flex-row sm:gap-1.5 sm:rounded-xl sm:px-2.5 sm:text-sm ${selected ? 'font-semibold text-accent-500 sm:bg-accent-500/10' : 'font-medium opacity-65 hover:bg-current/5 hover:opacity-100'}`}>
        <Icon size={19} aria-hidden="true" className="shrink-0" />
        <span>{label}</span>
      </button>
    );
  });

  const renderBookRow = (book: DiscoveryBook, deferCover = false) => {
    const saved = wishlist.savedIds.has(book.id);
    return <article key={book.id} className="mypage-book-list-item flex items-center">
      <BookDetailLink bookId={book.id} onOpen={() => openBook(book)} label={book.title} className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg pr-3 sm:gap-4 sm:pr-4">
        <BookCover url={book.coverUrl} identity={book.id} title={book.title} coverLoading={deferCover ? 'direct-with-proxy-fallback' : undefined} />
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-semibold leading-6 group-hover:text-accent-500">{book.title}</h3>
          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] leading-5 opacity-50">{book.author && <span>{book.author}</span>}{book.genre && <span>{book.genre}</span>}{[...new Set(book.platforms.map(({ label }) => label))].map((label) => <span key={label}>{label}</span>)}{book.sourceCount !== null && <span>{sourceCountFormat.format(book.sourceCount)} 조회·다운로드</span>}</div>
          {book.tags.length > 0 && <p className="mt-1 truncate text-[11px] opacity-40">{book.tags.slice(0, 5).map((name) => `#${name}`).join(' ')}</p>}
        </div>
      </BookDetailLink>
      <button type="button" aria-label={`${book.title} 위시리스트 ${saved ? '제거' : '추가'}`} aria-pressed={saved} disabled={wishlist.loading || wishlist.saving} onClick={() => void wishlist.setSaved(book, !saved)} className={`flex size-10 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${saved ? 'bg-accent-500/10 text-accent-500' : 'opacity-65 hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] hover:opacity-100'}`}>{saved ? <Check size={18} /> : <Plus size={18} />}</button>
    </article>;
  };

  const renderRecommendationList = (books: readonly DiscoveryBook[] | undefined) => {
    if (!books && wishlist.error) return null;
    if (!books) return <p role="status" className="py-10 text-center text-sm opacity-65">추천 도서를 불러오는 중…</p>;
    if (!books.length) return <p className="py-8 text-center text-sm opacity-65">추천 도서가 아직 없습니다.</p>;
    const sorted = recommendationSort === 'recommended' ? books : [...books].sort(bookOrder[recommendationSort]);
    return <section aria-label="추천 도서 목록" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs opacity-55">{books.length.toLocaleString()}권</p>
        <ListSort label="추천 도서 정렬" value={recommendationSort} options={recommendationSorts} onChange={setRecommendationSort} />
      </div>
      <div className="mypage-divided-list">{sorted.map((book) => renderBookRow(book, true))}</div>
    </section>;
  };

  return (
    <div data-my-page="true" className={`min-h-dvh [--mypage-title-height:4.8rem] [--mypage-title-half:calc(var(--mypage-title-height)/2)] ${showConnect ? '[--mypage-connect-width:2.75rem]' : '[--mypage-connect-width:0rem]'}`} style={{ ...themeVariables, backgroundColor: 'var(--viewer-theme-bg)', color: 'var(--viewer-theme-text)' }}>
      <header ref={titleRow} className="hidden sm:block">
        <div className="mx-auto flex h-[var(--mypage-title-height)] max-w-5xl items-center pl-[5.25rem] pr-[calc(8rem+var(--mypage-connect-width))]">
          <h1 className="text-[1.4375rem] leading-8 font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      <div className="pointer-events-none sticky top-0 z-30 -mt-[var(--mypage-title-half)] hidden pt-[var(--mypage-title-half)] sm:block">
        <div data-mypage-menu={compactMenu ? 'compact' : 'expanded'}
          className={`pointer-events-auto bg-[var(--viewer-theme-bg)] motion-safe:transition-[translate] motion-safe:duration-200 ${compactMenu ? '-translate-y-[var(--mypage-title-half)]' : ''}`}>
          <div className="relative mx-auto max-w-5xl px-5 py-1 sm:px-8">
            <div className={`absolute left-8 top-1 ${headerActionMotion} ${headerActionPosition}`}>{backButton}</div>
            <div className={`absolute right-8 top-1 z-10 ${headerActionMotion} ${headerActionPosition}`}>{shortcuts}</div>
            {compactMenu && (
              <span aria-hidden="true" data-mypage-header-divider className="pointer-events-none absolute right-[calc(7.5rem+var(--mypage-connect-width))] top-4.5 h-4 w-px bg-current/25" />
            )}
            <nav aria-label="마이페이지 메뉴" className={`flex gap-1 motion-safe:transition-[margin] motion-safe:duration-200 ${compactMenu ? 'ml-[3.25rem] mr-[calc(6rem+var(--mypage-connect-width))]' : ''}`}>
              {mainItems}
            </nav>
          </div>
        </div>
      </div>
      <header data-mypage-mobile-header className="sticky top-0 z-30 bg-[var(--viewer-theme-bg)] pt-[env(safe-area-inset-top)] sm:hidden">
        <div className="flex h-14 items-center justify-between gap-2 px-3">
          {backButton}
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
          {shortcuts}
        </div>
      </header>
      <footer className="fixed inset-x-0 bottom-0 z-40 border-t border-current/10 bg-[var(--viewer-theme-bg)] pb-[env(safe-area-inset-bottom)] sm:hidden">
        <nav aria-label="마이페이지 하단 메뉴" className="grid grid-cols-5">
          {mainItems}
        </nav>
      </footer>
      <div className={`mx-auto max-w-5xl px-5 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:px-8 sm:pb-14 ${showSectionTabs ? 'pt-[1.05rem] sm:pt-[1.4rem]' : 'pt-6 sm:pt-8'}`}>
        {showSectionTabs && (
          <nav aria-label={`${activeGroup?.label} 메뉴`} className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 mb-6 flex flex-wrap gap-x-5 bg-[var(--viewer-theme-bg)] sm:top-[3.25rem] sm:mb-8 sm:gap-x-7">
            {sectionTabs.map(({ id, label, selected, select }) => (
              <button key={id} type="button" onClick={select} aria-current={selected ? (tab === 'browse' ? 'true' : 'page') : undefined}
                className={`min-h-11 whitespace-nowrap border-b-2 px-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent-500 ${selected ? 'border-accent-500 font-semibold text-accent-500' : 'border-transparent opacity-65 hover:opacity-100'}`}>
                {label}
              </button>
            ))}
          </nav>
        )}
        <main className="min-w-0 space-y-4 sm:space-y-6" aria-label={bookId ? '도서 상세정보' : detailLabel}>
          {tab === 'read' && <div hidden={Boolean(bookId)}>
            {signedIn ? <ReadBooks key={ownerKey} ownerKey={ownerKey} active={!bookId} onOpenBook={openBook} getDetailId={readBookDetailId} onRetryCatalog={catalogError ? retryCatalog : undefined} reviews={reviews.data?.reviews} reviewError={reviews.error} onRetryReviews={reviews.refresh} />
              : <section aria-label="이 기기에서 읽은 책">
                <h2 className="mb-3 text-lg font-semibold tracking-tight">이 기기에서 읽은 책</h2>
                {deviceReadBooks.length ? <ul className="mypage-divided-list">
                  {deviceReadBooks.map(({ id, book, title, position }) => (
                    <li key={id} className="mypage-book-list-item">
                      <button type="button" onClick={() => props.onOpenDeviceBook(book)}
                        className="flex min-h-11 w-full items-center gap-3 px-1 text-left hover:text-accent-500">
                        <span className="min-w-0 grow break-words text-sm font-semibold">{title}</span>
                        <span className="shrink-0 text-xs opacity-65">{position.progressPercent.toFixed(1)}%</span>
                      </button>
                    </li>
                  ))}
                </ul> : <p className="text-sm opacity-60">이 기기에 저장된 읽기 위치가 없습니다.</p>}
              </section>}
          </div>}
          {tab === 'browse' && <div hidden={Boolean(bookId)}><PublicBrowse key={`${ownerKey}:${feedSection}`} section={feedSection} owner={ownerKey} onOpenBook={openBookById} /></div>}
          {(showOverview || showRecommendationList || tab === 'calendar') && <div hidden={Boolean(bookId)} className="space-y-8 [--mypage-cover-width:clamp(3.85rem,20.3vw,5.25rem)] sm:space-y-10">
            {showOverview && (
              <DashboardBookRow title="위시리스트" books={dashboardWishlist ?? []}
                onOpenBook={openBook} onShowAll={() => openTab('wishlist')}>
                {!wishlist.error && dashboardWishlist === undefined ? <p role="status" className="text-sm opacity-60">위시리스트를 불러오는 중…</p>
                  : !wishlist.error && dashboardWishlist?.length === 0 && <div className="flex flex-wrap items-center gap-x-4">
                    <p className="text-sm opacity-60">담아둔 책이 없습니다.</p>
                    <button type="button" onClick={() => openTab('discover')} className="flex min-h-10 items-center gap-1.5 text-xs font-semibold text-accent-500"><Plus size={16} />도서 찾아보기</button>
                  </div>}
              </DashboardBookRow>
            )}
            {(showOverview || (showRecommendationList && props.showRecommendedBooks && catalog)) && (
              <ReadBooks key={`read:${ownerKey}`} ownerKey={ownerKey} onShowAll={() => openTab('read')} onOpenBook={openBook} getDetailId={readBookDetailId} onRetryCatalog={catalogError ? retryCatalog : undefined}
                hidePreview={showRecommendationList || !signedIn} active={!bookId}
                renderBeforePreview={(readBooks) => <>
                  {!bookId && props.showRecommendedBooks && recommendationRanker && <RecommendedBooks rank={recommendationRanker.rank} wishlist={dashboardWishlist} readBooks={readBooks}
                    previousBooks={previousRecommendations} keepPrevious={keepRecommendations}
                    onRemember={rememberRecommendations} onOpenBook={openBook} onShowAll={() => openTab('recommendations')}
                    renderList={showRecommendationList ? renderRecommendationList : undefined} />}
                  {showOverview && <MyReviews key={ownerKey} owner={ownerKey} paused={Boolean(bookId)} onShowAll={() => openTab('reviews')} onOpenBook={openBookById} />}
                </>} />
            )}
            {showOverview && !signedIn && <DashboardBookRow title="이 기기에서 읽은 책" books={deviceReadBooks}
              onShowAll={() => openTab('read')} onOpenBook={({ book }) => props.onOpenDeviceBook(book)} openInReader>
              {!deviceReadBooks.length && <p className="text-sm opacity-60">이 기기에 저장된 읽기 위치가 없습니다.</p>}
            </DashboardBookRow>}
            {showRecommendationList && (!props.showRecommendedBooks
              ? <p className="text-sm opacity-65">마이페이지 설정에서 추천 도서 보기를 켤 수 있습니다.</p>
              : !catalog && (catalogError
                ? <p role="alert" className="text-sm opacity-65">도서 정보를 불러오지 못했습니다. <button type="button" onClick={retryCatalog} className="text-accent-500">다시 시도</button></p>
                : renderRecommendationList(undefined)))}
            {!showRecommendationList && <ReadingDashboard
              ownerKey={ownerKey}
              active={!bookId}
              onRefresh={props.canRefresh && !bookId ? props.onRefresh : undefined}
              onOpenStatistics={() => openTab('statistics')}
              onOpenAnnotations={() => openTab('annotations')}
            />}
          </div>}
          {bookId ? (
            <BookDetail key={`${ownerKey}:${bookId}`} bookId={bookId} discovery={detailBook} readBook={readSource} ownerKey={ownerKey} sharedDrive={props.sharedDrive} onSharedDriveReconnect={props.onSharedDriveReconnect} books={books} progress={progress} bookmarkProgress={bookmarkProgress} catalogLoading={catalogLoading && !detailBook} identityBlocked={Boolean(readMatch?.blocked || (catalogError && readSource?.platformWorkKeys?.length))} saved={detailSaved} focusReview={focusReview} catalog={catalog} rotationSeed={recommendationSeed} onOpenRelatedBook={openBook} onSearchCatalog={openDiscoverySearch} />
          ) : <>
          {wishlist.error && <p role="alert" className="text-sm text-accent-500">{wishlist.error} {signedIn && <button type="button" onClick={() => void wishlist.refresh()} className="underline">위시리스트 다시 불러오기</button>}</p>}
          {tab === 'reviews' && (signedIn ? <MyReviews key={ownerKey} owner={ownerKey} onOpenBook={openBookById} />
            : <p className="mypage-section text-sm">내 평가는 로그인 후 이용할 수 있습니다.</p>)}
          {tab === 'sharing' && <>
            <section className="mypage-section max-w-md space-y-2" aria-label="화면 설정">
              <h2 className="text-xl font-semibold">화면 설정</h2>
              <label className="flex min-h-10 items-center justify-between gap-4 text-sm">
                추천 도서 보기
                <input type="checkbox" checked={props.showRecommendedBooks} className="size-4 accent-[var(--accent-500)]"
                  onChange={(event) => props.onShowRecommendedBooksChange(event.target.checked)} />
              </label>
              {signedIn && <AdminSettingsLink ownerKey={ownerKey} />}
            </section>
            {signedIn
              ? <MyPageSharingSettings key={ownerKey} owner={ownerKey} />
              : <p className="mypage-section text-sm">공개 설정은 로그인 후 이용할 수 있습니다.</p>}
          </>}
          {browse && <>
            <div>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">{detailLabel}</h2>
                {discovering
                  ? <ListSort label="도서 정렬" value={discoverySort} options={catalogSorts} onChange={(sort) => { setDiscoverySort(sort); setVisibleCount(60); }} />
                  : <ListSort label="위시리스트 정렬" value={wishlistSort} options={wishlistSorts} onChange={(sort) => { setWishlistSort(sort); setVisibleCount(60); }} />}
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs opacity-45">{tab === 'wishlist' ? `담아둔 책 ${wishlist.entries.length.toLocaleString()}권` : groupedCatalog ? `공개 메타데이터 ${groupedCatalog.books.length.toLocaleString()}권` : '공개 메타데이터에서 읽고 싶은 책을 찾아보세요.'}</p>
                {tab === 'wishlist' && <button type="button" onClick={() => openTab('discover')} className="flex min-h-9 shrink-0 items-center gap-1 px-1 text-xs font-semibold text-accent-500"><Plus size={15} aria-hidden="true" />추가</button>}
              </div>
            </div>
            {discovering && <section aria-label="도서 검색 및 필터" className="space-y-2.5">
              <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg px-3 py-1 ring-1 ring-inset ring-current/15 focus-within:outline-2 focus-within:outline-accent-500">
                {tagMode ? <Hash size={17} aria-hidden="true" className="shrink-0 text-accent-500" />
                  : authorMode ? <AtSign size={17} aria-hidden="true" className="shrink-0 text-accent-500" />
                  : <Search size={17} aria-hidden="true" className="shrink-0 opacity-60" />}
                {selectedTags.map((name) => (
                  <button key={name} type="button" aria-label={`#${name} 제거`} onClick={() => removeTag(name)}
                    className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-md bg-accent-500/15 px-2 text-xs font-semibold text-accent-500 hover:bg-accent-500/25">
                    <span className="truncate">#{name}</span><X size={12} aria-hidden="true" className="shrink-0" />
                  </button>
                ))}
                <input ref={discoverySearchRef} aria-label="도서 제목, 작가 또는 태그 검색" value={query}
                  onChange={(event) => { setQuery(event.target.value); setExactAuthor(false); setVisibleCount(60); }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing && suggestions[0]) {
                      event.preventDefault();
                      selectSuggestion(suggestions[0].label);
                    }
                  }}
                  placeholder="제목, @작가명 또는 #태그 검색" className="min-h-8 min-w-0 flex-1 basis-36 bg-transparent text-sm outline-none" />
              </div>
              {suggestions.length > 0 && (
                <DiscoverySuggestions key={tagMode ? `#${tagQuery}` : query}
                  suggestions={suggestions} tagMode={tagMode} onSelect={selectSuggestion} />
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <select aria-label="도서 플랫폼 필터" value={source} onChange={(event) => { setSource(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 플랫폼</option><option value="series">네이버 시리즈</option><option value="kakao">카카오페이지</option><option value="novelpia">노벨피아</option></select>
                <select aria-label="도서 장르 필터" value={genre} onChange={(event) => { setGenre(event.target.value); setVisibleCount(60); }} className={inputClass}><option value="">모든 장르</option>{genres.map((name) => <option key={name}>{name}</option>)}</select>
                <select aria-label="도서 태그 필터" value="" onChange={(event) => addTag(event.target.value)} className={inputClass}><option value="">태그 추가</option>{tags.filter((name) => !selectedTags.includes(name)).map((name) => <option key={name}>{name}</option>)}</select>
              </div>
            </section>}
            <section aria-label="도서 목록">
              {loading ? <div role="status" className="py-10 text-center text-sm opacity-65">{tab === 'discover' ? '도서 정보를 불러오는 중…' : '위시리스트를 불러오는 중…'}</div>
              : tab === 'discover' && catalogError ? <div role="alert" className="py-8 text-center"><p className="text-sm opacity-70">도서 정보를 불러오지 못했습니다.</p><button type="button" onClick={retryCatalog} className="mt-3 min-h-10 px-3 text-sm font-medium text-accent-500">다시 시도</button></div>
              : results.length === 0 ? <div className="py-8 text-center"><BookOpen size={28} className="mx-auto mb-3 opacity-40" /><p className="text-sm opacity-70">{tab === 'wishlist' ? '담아둔 책이 없습니다.' : discoveryBooks?.length ? '조건에 맞는 책이 없습니다.' : '공개된 도서 정보가 없습니다.'}</p>{Boolean(discoveryBooks?.length) && <button type="button" onClick={() => openTab('discover')} className="mt-3 text-sm text-accent-500">필터 초기화</button>}</div>
              : <div className="mypage-divided-list">
                {results.slice(0, visibleCount).map((book) => renderBookRow(book))}
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
