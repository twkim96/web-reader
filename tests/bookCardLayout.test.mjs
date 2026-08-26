import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import bookCardModule from '../src/components/shelf/BookCard.tsx';
import emptyStateModule from '../src/components/shelf/EmptyState.tsx';
import bookUtilsModule from '../src/components/shelf/bookUtils.ts';
import generatedBookCoverModule from '../src/components/shelf/GeneratedBookCover.tsx';

const { BookCard, getFittingShelfTagCount } = bookCardModule;
const { EmptyState } = emptyStateModule;
const { canRequestPublicBookMetadata, getVisibleBookInfoCatalogTags } = bookUtilsModule;
const {
  GENERATED_BOOK_COVER_PALETTE,
  GeneratedBookCover,
  getGeneratedBookCoverStyle,
} = generatedBookCoverModule;

const modalSurfaceSources = [
  '../src/components/reader/ReaderModalFrame.tsx',
  '../src/components/ConfirmDialog.tsx',
  '../src/components/EpubSearchModal.tsx',
  '../src/components/LibraryAnnotationModal.tsx',
  '../src/components/LibraryReadingStatisticsModal.tsx',
  '../src/components/LoginDisclosureModal.tsx',
  '../src/components/ManageModal.tsx',
  '../src/components/ShelfSearchModal.tsx',
  '../src/components/SyncConflictResolutionDialog.tsx',
  '../src/components/reader/ProgressJumpConfirmDialog.tsx',
  '../src/components/reader/ReaderTtsControls.tsx',
  '../src/components/reader/SyncConflictDialog.tsx',
  '../src/components/shelf/BookInfoModal.tsx',
  '../src/components/shelf/ImportBookModal.tsx',
  '../src/components/shelf/ShelfFilterModal.tsx',
];

const props = {
  book: {
    id: 'layout-book',
    name: '레이아웃 검증.epub',
    mimeType: 'application/epub+zip',
  },
  progress: {
    bookId: 'layout-book',
    cfi: 'epubcfi(/6/2)',
    progressPercent: 42.5,
    lastRead: Date.parse('2026-08-17T00:00:00Z'),
  },
  isDownloaded: true,
  theme: {
    bg: 'bg-black',
    text: 'text-white',
    border: 'border-white/10',
    secondary: 'bg-white/5',
  },
  onOpen: () => undefined,
  onDeleteProgress: () => undefined,
  catalog: {
    record: {
      id: 1,
      platformMask: 3,
      canonicalGenreId: 1,
      tagIds: [1, 2],
      popularityScore: 9000,
      sourceRanks: [9000, 8000, null],
      sourceCounts: [1_669_000, 1_378_000, null],
    },
    genreLabel: '판타지',
    tags: [
      { id: 1, label: '전쟁', titleCount: 100 },
      { id: 2, label: '대체역사', titleCount: 80 },
    ],
  },
};

const renderCard = (viewMode, catalog = props.catalog, overrides = {}) => {
  const html = renderToStaticMarkup(React.createElement(BookCard, {
    ...props,
    ...overrides,
    catalog,
    viewMode,
  }));
  return parseHTML(html).document;
};

const renderCardWithCover = (viewMode, catalog = props.catalog, overrides = {}) => {
  const html = renderToStaticMarkup(React.createElement(BookCard, {
    ...props,
    ...overrides,
    catalog,
    viewMode,
    coverUrl: 'blob:https://reader.test/cached-cover',
  }));
  return parseHTML(html).document;
};

test('uses one 14px outer radius for grid cards and every modal surface', async () => {
  const [globals, bookCardSource, ...modalSources] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/BookCard.tsx', import.meta.url), 'utf8'),
    ...modalSurfaceSources.map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  ]);

  assert.match(globals, /\.app-panel-radius\s*\{\s*border-radius:\s*14px;/);
  assert.match(bookCardSource, /data-shelf-book-card="true"[\s\S]*?className=\{`app-panel-radius/);
  modalSources.forEach((source, index) => {
    assert.match(source, /app-panel-radius/, modalSurfaceSources[index]);
  });
});

test('uses one 7px radius for shelf metadata tags and chips', async () => {
  const [globals, bookCardSource, searchSource, filterSource, bookInfoSource] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/BookCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ShelfSearchModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/ShelfFilterModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/BookInfoModal.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(globals, /\.app-tag-radius\s*\{\s*border-radius:\s*var\(--app-radius-md\);/);
  assert.match(bookCardSource, /const localChipClass = 'app-tag-radius/);
  assert.match(bookCardSource, /const genreChipClass = 'app-tag-radius/);
  assert.match(bookCardSource, /const tagChipClass = 'app-tag-radius/);
  assert.match(searchSource, /data-shelf-tag-search-result=\{tag\.id\}[\s\S]*?className="app-tag-radius/);
  assert.match(filterSource, /const chip = \(active: boolean\) => `app-tag-radius/);
  assert.match(bookInfoSource, /data-book-info-tag-row="true"[\s\S]*?app-tag-radius/);
  assert.match(bookInfoSource, /data-book-catalog-tag="true"[\s\S]*?className="app-tag-radius/);
});

test('uses a Spotlight-like 20px radius for both search modals', async () => {
  const [globals, shelfSearchSource, epubSearchSource] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ShelfSearchModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EpubSearchModal.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(globals, /\.app-search-modal-radius\s*\{\s*border-radius:\s*20px;/);
  assert.match(shelfSearchSource, /data-shelf-search-modal="true"[\s\S]*?app-search-modal-radius/);
  assert.match(epubSearchSource, /data-epub-search-modal="true"[\s\S]*?app-search-modal-radius/);
});

test('keeps one persistent bottom shelf dock at 34px on mobile and desktop', async () => {
  const shelfHeaderSource = await readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8');

  assert.match(shelfHeaderSource, /const bottomDockClass = `[^`]*rounded-\[34px\]/);
  assert.doesNotMatch(shelfHeaderSource, /md:rounded-/);
  assert.match(shelfHeaderSource, /data-shelf-bottom-dock="true"/);
  assert.doesNotMatch(shelfHeaderSource, /data-shelf-top-dock|isBottomDock|md:hidden[^\n]*bottomDock/);
});

test('uses light title-cased shelf library labels', async () => {
  const shelfHeaderSource = await readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8');

  assert.match(shelfHeaderSource, /data-shelf-library-label="true"/);
  assert.match(shelfHeaderSource, /isGuest \? 'Guest Library' : \(isOfflineMode \? 'Local Library' : 'Cloud Library'\)/);
  const headingSource = shelfHeaderSource.match(/<span[\s\S]*?role="heading"[\s\S]*?data-shelf-library-label="true"[\s\S]*?<\/span>/)?.[0] ?? '';
  assert.match(headingSource, /\bfont-medium\b/);
  assert.match(headingSource, /text-\[21px\]/);
  assert.match(headingSource, /md:text-\[22px\]/);
  assert.doesNotMatch(headingSource, /\buppercase\b|\bfont-normal\b|\bfont-black\b/);
});

test('keeps the shelf header close to the safe area on mobile and desktop', async () => {
  const shelfHeaderSource = await readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8');

  assert.match(shelfHeaderSource, /pt-\[calc\(env\(safe-area-inset-top\)\+0\.5rem\)\]/);
  assert.doesNotMatch(shelfHeaderSource, /md:pt-/);
});

test('keeps mobile layout and auth controls in the header while tightening the shelf gap', async () => {
  const [shelfHeaderSource, shelfSource] = await Promise.all([
    readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/index.tsx', import.meta.url), 'utf8'),
  ]);
  const mobileControls = shelfHeaderSource.match(/data-shelf-mobile-layout-controls="true"[\s\S]*?<\/div>/)?.[0] ?? '';
  const shelfContent = shelfSource.match(/data-shelf-content="true"[^>]+/)?.[0] ?? '';

  assert.match(mobileControls, /data-shelf-filter-control|renderLayoutControls/);
  assert.match(mobileControls, /data-shelf-auth-control/);
  assert.match(shelfHeaderSource, /\bpb-2\b/);
  assert.match(shelfContent, /\bpt-3\b/);
  assert.doesNotMatch(shelfContent, /\bmd:pt-/);
  assert.match(shelfSource, /grid-cols-1 gap-4 sm:grid-cols-2/);
});

test('keeps the shelf identity control flat and the user label light', async () => {
  const shelfHeaderSource = await readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8');
  const identityStart = shelfHeaderSource.indexOf('data-shelf-brand-control="true"');
  const identityEnd = shelfHeaderSource.indexOf('</button>', identityStart);
  const identityControl = shelfHeaderSource.slice(identityStart, identityEnd);

  assert.match(identityControl, /\bh-full\b/);
  assert.match(identityControl, /text-\[color:var\(--viewer-theme-text\)\]/);
  assert.match(identityControl, /\bsize-10\b/);
  assert.doesNotMatch(identityControl, /bg-accent|bg-slate|shadow|rounded-/);
  assert.match(identityControl, /\btext-accent-500\b/);
  assert.match(identityControl, /<(?:KeyRound|WifiOff|Library) size=\{31\} \/>/);
  assert.match(identityControl, /text-\[10px\] font-normal tracking-wide opacity-55/);
  assert.match(shelfHeaderSource, /const mobileHeaderIconSize = 22/);
});

test('maps non-reader controls to an optical radius scale and keeps exclusions explicit', async () => {
  const [globals, pageSource, shelfSearchSource, epubSearchSource, readerToolbarSource, selectionMenuSource, highlightMenuSource] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ShelfSearchModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/EpubSearchModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/reader/ReaderToolbar.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/reader/TextSelectionMenu.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/reader/HighlightActionMenu.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(globals, /--app-radius-xs:\s*3px;/);
  assert.match(globals, /--app-radius-sm:\s*5px;/);
  assert.match(globals, /--app-radius-md:\s*7px;/);
  assert.match(globals, /--app-radius-lg:\s*8px;/);
  assert.match(globals, /--app-radius-xl:\s*10px;/);
  assert.match(globals, /--app-radius-2xl:\s*12px;/);
  assert.match(globals, /\.app-optical-radius :where\(\.rounded-xl\):not\(\.app-radius-exempt, \.app-radius-exempt \*\)/);
  assert.match(globals, /\.app-optical-radius :where\(\.rounded-2xl\):not\(\.app-radius-exempt, \.app-radius-exempt \*\)/);
  assert.match(pageSource, /className=\{`app-optical-radius min-h-screen/);
  [shelfSearchSource, epubSearchSource, readerToolbarSource, selectionMenuSource, highlightMenuSource]
    .forEach((source) => assert.match(source, /app-radius-exempt/));
});

const renderEmptyState = ({ isGuest, isOfflineMode }) => {
  const html = renderToStaticMarkup(React.createElement(EmptyState, {
    searchKeyword: '',
    isGuest,
    isOfflineMode,
    theme: props.theme,
    onClearSearch: () => undefined,
    onToggleCloud: () => undefined,
    onLogin: () => undefined,
    onShowImportConfirm: () => undefined,
    onAddSampleBook: () => undefined,
    isAddingSampleBook: false,
    sampleBookFeedback: '',
  }));
  return parseHTML(html).document;
};

test('uses distinct flat empty-shelf actions for guest, Firebase-only, and Drive states', () => {
  const guest = renderEmptyState({ isGuest: true, isOfflineMode: true });
  assert.equal(guest.querySelector('[data-empty-shelf-heading="true"]')?.textContent, '보관함이 비어있음.');
  assert.equal(guest.querySelector('[data-empty-shelf-action="google"]')?.textContent.trim(), 'Google 계정을 연동');
  assert.equal(guest.querySelector('[data-empty-shelf-action="sample"]')?.textContent.trim(), '샘플 도서를 추가');
  assert.match(guest.querySelector('[data-empty-shelf-action="google"]')?.className ?? '', /text-accent-500/);
  assert.match(guest.querySelector('[data-empty-shelf-action="sample"]')?.className ?? '', /text-accent-500/);
  assert.equal(guest.querySelector('p')?.textContent.replace(/\s+/g, ' ').trim(), '책을 보관함에 추가하려면 Google 계정을 연동하거나 샘플 도서를 추가해주세요.');
  assert.deepEqual(
    [...guest.querySelectorAll('[data-empty-shelf-copy-line]')].map((line) => [
      line.getAttribute('data-empty-shelf-copy-line'),
      line.textContent.replace(/\s+/g, ' ').trim(),
    ]),
    [
      ['first', '책을 보관함에 추가하려면 Google 계정을 연동'],
      ['second', '하거나 샘플 도서를 추가해주세요'],
    ],
  );
  assert.equal(guest.querySelector('[data-empty-shelf-action="import"]'), null);

  const firebaseOnly = renderEmptyState({ isGuest: false, isOfflineMode: true });
  assert.equal(firebaseOnly.querySelector('[data-empty-shelf-action="cloud"]')?.textContent.trim(), '드라이브에 로그인');
  assert.equal(firebaseOnly.querySelector('[data-empty-shelf-action="import"]')?.textContent.trim(), '파일을 로컬에 업로드');
  assert.match(firebaseOnly.querySelector('[data-empty-shelf-action="cloud"]')?.className ?? '', /text-accent-500/);
  assert.match(firebaseOnly.querySelector('[data-empty-shelf-action="import"]')?.className ?? '', /text-accent-500/);
  assert.equal(firebaseOnly.querySelector('p')?.textContent.replace(/\s+/g, ' ').trim(), '책을 보관함에 추가하려면 드라이브에 로그인하거나 파일을 로컬에 업로드해주세요.');
  assert.deepEqual(
    [...firebaseOnly.querySelectorAll('[data-empty-shelf-copy-line]')].map((line) => (
      line.getAttribute('data-empty-shelf-copy-line')
    )),
    ['first', 'second'],
  );
  assert.equal(firebaseOnly.querySelector('[data-empty-shelf-action="sample"]'), null);

  const drive = renderEmptyState({ isGuest: false, isOfflineMode: false });
  const driveUpload = drive.querySelector('[data-empty-shelf-action="drive"]');
  assert.equal(driveUpload?.textContent.trim(), '파일을 드라이브에 업로드');
  assert.equal(drive.querySelector('p')?.textContent.replace(/\s+/g, ' ').trim(), '책을 보관함에 추가하려면 파일을 드라이브에 업로드해주세요.');
  assert.equal(driveUpload?.tagName, 'BUTTON');
  assert.equal(driveUpload?.getAttribute('type'), 'button');
  assert.match(driveUpload?.className ?? '', /text-accent-500/);
  assert.equal(drive.querySelector('[data-empty-shelf-copy-line]'), null);
  assert.equal(drive.querySelector('[data-empty-shelf-action="sample"]'), null);

  for (const document of [guest, firebaseOnly, drive]) {
    const panel = document.querySelector('[data-empty-shelf-panel="true"]');
    assert.equal(panel?.querySelector('svg'), null);
    assert.doesNotMatch(panel?.textContent ?? '', /LIBRARY EMPTY|REFRESH LIBRARY|OPEN GOOGLE DRIVE/);
  }

  for (const line of guest.querySelectorAll('[data-empty-shelf-copy-line]')) {
    assert.match(line.className, /whitespace-normal/);
    assert.match(line.className, /sm:whitespace-nowrap/);
  }
  assert.doesNotMatch(
    guest.querySelector('[data-empty-shelf-heading="true"]')?.parentElement?.className ?? '',
    /opacity-65/,
  );
});

test('keeps shelf cards keyboard-operable and clears long-press work on unmount', async () => {
  for (const viewMode of ['simple', 'grid', 'list']) {
    const card = renderCard(viewMode).querySelector('[data-shelf-book-card="true"]');
    assert.equal(card?.getAttribute('role'), 'button');
    assert.equal(card?.getAttribute('tabindex'), '0');
    assert.equal(card?.getAttribute('aria-label'), '레이아웃 검증 열기');
    assert.match(card?.className ?? '', /focus-visible:ring/);
  }

  const bookCardSource = await readFile(new URL('../src/components/shelf/BookCard.tsx', import.meta.url), 'utf8');
  assert.match(bookCardSource, /useEffect\(\(\) => clearLongPressTimer, \[clearLongPressTimer\]\)/);
  assert.match(bookCardSource, /event\.key !== 'Enter' && event\.key !== ' '/);
});

test('deduplicates shelf history, reuses cover URLs, and labels theme choices', async () => {
  const [shelfSource, coverSource, themeSource] = await Promise.all([
    readFile(new URL('../src/components/shelf/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/useShelfBookCovers.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ThemeModal.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(shelfSource, /if \(window\.history\.state\?\.panel !== 'shelf'\) \{\s*window\.history\.pushState/);
  assert.match(coverSource, /existing\.fingerprint === fingerprint/);
  assert.match(coverSource, /existing\.revision === bookRevision/);
  assert.match(coverSource, /catch \(error\) \{\s*console\.warn\(`\[Shelf\] Failed to load cached book cover for/);
  assert.match(coverSource, /useLayoutEffect\(\(\) => \{\s*const staleUrls = pendingRevocationsRef\.current/);
  assert.match(themeSource, /aria-pressed=\{settings\.theme === key\}/);
  assert.match(themeSource, /aria-label=\{`\$\{label\} 테마`\}/);
});

test('uses the same cover frame for cached and generated shelf covers', () => {
  for (const viewMode of ['simple', 'grid', 'list']) {
    const covered = renderCardWithCover(viewMode);
    const cover = covered.querySelector('[data-shelf-book-cover="true"]');
    const coverFrame = covered.querySelector('[data-shelf-book-cover-frame="true"]');
    assert.ok(cover);
    assert.ok(coverFrame);
    assert.equal(covered.querySelector('[data-generated-book-cover="true"]'), null);
    assert.equal(covered.querySelector('[data-shelf-book-icon="true"]'), null);
    assert.equal(covered.querySelector('[data-shelf-book-icon-frame="true"]'), null);
    assert.match(cover.className, /object-cover/);
    assert.doesNotMatch(coverFrame.className, /bg-accent|shadow|rounded/);

    const fallback = renderCard(viewMode);
    const generated = fallback.querySelector('[data-generated-book-cover="true"]');
    const fallbackFrame = fallback.querySelector('[data-shelf-book-cover-frame="true"]');
    assert.equal(fallback.querySelector('[data-shelf-book-cover="true"]'), null);
    assert.ok(fallbackFrame);
    assert.ok(generated);
    assert.equal(fallback.querySelector('[data-shelf-book-icon="true"]'), null);
    assert.equal(fallback.querySelector('[data-shelf-book-icon-frame="true"]'), null);
    assert.match(generated.textContent, /레이아웃 검증/);
  }
});

test('keeps generated cover colors deterministic and readable', () => {
  assert.deepEqual(GENERATED_BOOK_COVER_PALETTE, [
    '#B3CACC', '#99C7E8', '#CCC9B4', '#E8E899', '#CCB4C2',
    '#E89A99', '#467377', '#778793', '#4D4720', '#696843',
  ]);

  const first = getGeneratedBookCoverStyle('layout-book', '#141517');
  const repeated = getGeneratedBookCoverStyle('layout-book', '#141517');
  assert.deepEqual(first, repeated);

  const parseHex = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = (value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance = (hex) => {
    const [red, green, blue] = parseHex(hex).map(linear);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (left, right) => {
    const firstLuma = luminance(left);
    const secondLuma = luminance(right);
    return (Math.max(firstLuma, secondLuma) + 0.05) / (Math.min(firstLuma, secondLuma) + 0.05);
  };

  assert.ok(contrast(first.backgroundColor, first.color) >= 4.5);
  for (const backgroundColor of GENERATED_BOOK_COVER_PALETTE) {
    const selected = getGeneratedBookCoverStyle('layout-book', backgroundColor);
    assert.notEqual(selected.backgroundColor, backgroundColor);
    assert.ok(contrast(selected.backgroundColor, backgroundColor) >= 1.5);
  }
  const foregrounds = new Set(
    Array.from({ length: 64 }, (_, index) => getGeneratedBookCoverStyle(`book-${index}`).color),
  );
  assert.ok(foregrounds.has('#FFFFFF'));
  assert.ok(foregrounds.has('#111827'));
});

test('passes the active shelf background to generated covers', async () => {
  const document = renderCard('simple', props.catalog, { themeBackgroundColor: '#B3CACC' });
  const generated = document.querySelector('[data-generated-book-cover="true"]');
  assert.ok(generated);
  assert.notEqual(generated.style.backgroundColor.toUpperCase(), '#B3CACC');

  const [shelfSource, infoSource] = await Promise.all([
    readFile(new URL('../src/components/shelf/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/BookInfoModal.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(shelfSource, /const themeBackgroundColor = getThemeColors\(settings\)\.bg/);
  assert.match(shelfSource, /<BookCard[\s\S]*?themeBackgroundColor=\{themeBackgroundColor\}/);
  assert.match(infoSource, /surroundingBackgroundColor=\{themeBackgroundColor\}/);
});

test('starts generated cover titles near the top and keeps list text at seven pixels', () => {
  const html = renderToStaticMarkup(React.createElement(GeneratedBookCover, {
    identity: 'layout-book',
    title: '레이아웃 검증',
    variant: 'list',
  }));
  const document = parseHTML(html).document;
  const cover = document.querySelector('[data-generated-book-cover="true"]');
  const title = document.querySelector('[data-generated-book-cover-title="true"]');

  assert.ok(cover);
  assert.ok(title);
  assert.equal(cover.getAttribute('data-generated-book-cover-variant'), 'list');
  assert.match(cover.className, /text-\[7px\]/);
  assert.match(cover.className, /font-bold/);
  assert.doesNotMatch(cover.className, /font-black/);
  assert.match(title.className, /top-\[15%\]/);
  assert.match(title.className, /left-\[9%\]/);
  assert.match(title.className, /right-\[9%\]/);
});

test('uses a substantially larger generated-cover title in simple view', () => {
  const html = renderToStaticMarkup(React.createElement(GeneratedBookCover, {
    identity: 'layout-book',
    title: '레이아웃 검증',
    variant: 'simple',
  }));
  const document = parseHTML(html).document;
  const cover = document.querySelector('[data-generated-book-cover="true"]');

  assert.ok(cover);
  assert.equal(cover.getAttribute('data-generated-book-cover-variant'), 'simple');
  assert.match(cover.className, /text-\[14px\]/);
  assert.match(cover.className, /sm:text-\[15px\]/);
});

test('keeps the list cover compact and fills the left side of grid cards with a large cover', () => {
  const listFrame = renderCardWithCover('list')
    .querySelector('[data-shelf-book-cover-frame="true"]');
  assert.match(listFrame.className, /w-11/);
  assert.match(listFrame.className, /sm:w-12/);
  assert.match(listFrame.className, /h-16/);
  assert.match(listFrame.className, /sm:h-\[4\.25rem\]/);
  assert.match(listFrame.className, /sm:-my-1/);

  const gridCard = renderCardWithCover('grid');
  const gridFrame = gridCard.querySelector('[data-shelf-book-cover-frame="true"]');
  const gridLayout = gridCard.querySelector('[data-shelf-grid-cover-layout="true"]');
  assert.ok(gridLayout);
  assert.match(gridLayout.className, /grid-cols-\[7\.5rem_minmax\(0,1fr\)\]/);
  assert.match(gridLayout.className, /sm:grid-cols-\[8\.5rem_minmax\(0,1fr\)\]/);
  assert.match(gridLayout.className, /min-h-48/);
  assert.match(gridLayout.className, /sm:min-h-52/);
  assert.match(gridFrame.className, /h-full/);
  assert.match(gridFrame.className, /w-full/);
  const gridTitle = gridCard.querySelector('[data-shelf-grid-cover-title="true"]');
  const gridMeta = gridCard.querySelector('[data-shelf-grid-meta="true"]');
  const gridSourceSlot = gridCard.querySelector('[data-shelf-grid-cover-source-slot="true"]');
  const gridLocalTag = gridCard.querySelector('[data-shelf-local-tag="true"]');
  const gridTags = gridCard.querySelector('[data-shelf-grid-cover-tags="true"]');
  const gridTagSlot = gridCard.querySelector('[data-shelf-grid-cover-tag-slot="true"]');
  const gridProgress = gridCard.querySelector('[data-shelf-grid-progress-block="true"]');
  const gridCardRoot = gridCard.querySelector('[data-shelf-book-card="true"]');
  assert.ok(gridTitle);
  assert.ok(gridMeta);
  assert.ok(gridSourceSlot);
  assert.ok(gridLocalTag);
  assert.ok(gridTags);
  assert.ok(gridTagSlot);
  assert.ok(gridProgress);
  assert.ok(gridCardRoot);
  assert.match(gridTitle.className, /line-clamp-4/);
  assert.match(gridTitle.className, /text-sm/);
  assert.match(gridTitle.className, /sm:text-base/);
  assert.doesNotMatch(gridTitle.className, /text-lg/);
  assert.doesNotMatch(gridTitle.className, /sm:text-xl/);
  assert.equal(gridMeta.nextElementSibling, gridTitle);
  assert.equal(gridTitle.nextElementSibling, gridTagSlot);
  assert.equal(gridTagSlot.nextElementSibling, gridProgress);
  assert.equal(gridLocalTag.textContent, '로컬');
  assert.match(gridLocalTag.className, /bg-green-500\/15/);
  assert.match(gridLocalTag.className, /text-green-500/);
  assert.match(gridTags.className, /max-h-9/);
  assert.match(gridTags.className, /overflow-hidden/);
  assert.match(gridTagSlot.className, /mt-3/);
  assert.doesNotMatch(gridCardRoot.className, /h-full/);
  assert.match(gridCardRoot.className, /p-4/);
  assert.match(gridProgress.className, /mt-auto/);
  assert.match(gridProgress.className, /pt-3/);

  const progressDelete = gridCard.querySelector('[data-shelf-grid-progress-delete="true"]');
  assert.ok(progressDelete);
  assert.match(progressDelete.className, /h-5/);
  assert.match(progressDelete.className, /w-5/);
  assert.match(progressDelete.className, /p-0/);
  const progressDeleteIcon = gridCard.querySelector('[data-shelf-grid-progress-delete-icon="true"]');
  assert.ok(progressDeleteIcon);
  assert.equal(progressDeleteIcon.getAttribute('width'), '14');
  assert.equal(progressDeleteIcon.getAttribute('height'), '14');
});

test('renders the simple shelf card as cover, fixed metadata, title, and compact progress', () => {
  const document = renderCardWithCover('simple');
  const card = document.querySelector('[data-shelf-simple-card="true"]');
  const cover = document.querySelector('[data-shelf-simple-cover="true"]');
  const meta = document.querySelector('[data-shelf-simple-meta="true"]');
  const local = document.querySelector('[data-shelf-local-tag="true"]');
  const genre = document.querySelector('[data-shelf-simple-genre="true"]');
  const format = document.querySelector('[data-shelf-simple-format="true"]');
  const sourceCount = document.querySelector('[data-shelf-simple-source-count="true"]');
  const title = document.querySelector('[data-shelf-simple-title="true"]');
  const progress = document.querySelector('[data-shelf-simple-progress="true"]');
  const deleteButton = document.querySelector('[data-shelf-simple-progress-delete="true"]');

  assert.ok(card);
  assert.ok(cover);
  assert.ok(meta);
  assert.ok(local);
  assert.ok(genre);
  assert.ok(format);
  assert.ok(sourceCount);
  assert.ok(title);
  assert.ok(progress);
  assert.ok(deleteButton);
  assert.match(cover.className, /aspect-\[2\/3\]/);
  assert.match(cover.className, /app-tag-radius/);
  assert.equal(meta.children[0], local);
  assert.equal(meta.children[1], genre);
  assert.equal(meta.children[2], format);
  assert.equal(meta.children[3], sourceCount);
  assert.equal(local.textContent, '로컬');
  assert.equal(genre.textContent, '판타지');
  assert.equal(format.textContent, 'EPUB');
  assert.equal(sourceCount.textContent, '304.7만 조회');
  assert.match(meta.className, /flex-nowrap/);
  assert.match(meta.className, /whitespace-nowrap/);
  assert.match(meta.className, /\bh-5\b/);
  assert.equal(meta.nextElementSibling, title);
  assert.equal(title.nextElementSibling, progress);
  assert.match(title.className, /line-clamp-2/);
  assert.match(title.className, /min-h-10/);
  assert.match(title.textContent, /레이아웃 검증/);
  assert.match(progress.textContent, /42\.5%/);
  assert.match(progress.textContent, /2026/);
  assert.doesNotMatch(progress.textContent, /--\.--\./);
  assert.match(progress.className, /flex-nowrap/);
  assert.match(progress.className, /whitespace-nowrap/);
  assert.equal(deleteButton.querySelector('svg')?.getAttribute('width'), '13');
  assert.doesNotMatch(card.className, /app-panel-radius|\bborder\b|\bbg-/);
});

test('defaults to simple view and cycles simple, grid, and list modes', async () => {
  const [preferencesSource, headerSource] = await Promise.all([
    readFile(new URL('../src/components/shelf/useShelfPreferences.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/shelf/ShelfHeader.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(preferencesSource, /const VIEW_MODE_KEY = 'shelf_viewMode_v2'/);
  assert.match(preferencesSource, /typeof window === 'undefined'\) return 'simple'/);
  assert.match(preferencesSource, /saved === 'simple' \|\| saved === 'grid' \|\| saved === 'list'/);
  assert.match(preferencesSource, /current === 'simple'[\s\S]*?\? 'grid'[\s\S]*?current === 'grid'[\s\S]*?\? 'list'[\s\S]*?: 'simple'/);
  assert.match(headerSource, /Switch to Simple View/);
  assert.match(headerSource, /심플 보기/);
});

test('keeps horizontal grid cards readable in one mobile column and two wider columns', async () => {
  const shelfSource = await readFile(
    new URL('../src/components/shelf/index.tsx', import.meta.url),
    'utf8',
  );
  assert.match(shelfSource, /viewMode === 'grid'[\s\S]*?\? 'grid-cols-1 gap-4 sm:grid-cols-2'/);
  assert.doesNotMatch(shelfSource, /lg:grid-cols-3|xl:grid-cols-4/);
});

test('uses a cover-led responsive column layout for simple view', async () => {
  const shelfSource = await readFile(
    new URL('../src/components/shelf/index.tsx', import.meta.url),
    'utf8',
  );

  assert.match(shelfSource, /viewMode === 'simple'[\s\S]*?grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 md:grid-cols-4 lg:grid-cols-5/);
});

test('gives list titles the flexible column and keeps format and progress compact on the right', () => {
  const document = renderCard('list');
  const card = document.querySelector('[data-shelf-book-card="true"]');
  const localTag = document.querySelector('[data-shelf-local-tag="true"]');
  const format = document.querySelector('[data-shelf-list-format="true"]');
  const progress = document.querySelector('[data-shelf-list-progress="true"]');

  assert.ok(card);
  assert.ok(localTag);
  assert.ok(format);
  assert.ok(progress);
  assert.equal(document.querySelector('[data-shelf-list-local="true"]'), null);
  assert.match(card.className, /sm:grid-cols-\[3rem_minmax\(0,1fr\)_4rem_10rem\]/);
  assert.equal(localTag.textContent, '로컬');
  assert.match(format.textContent, /EPUB/);
  assert.equal(format.nextElementSibling, progress);
});

test('places one combined view count above the progress percentage', () => {
  const document = renderCard('list');
  const progress = document.querySelector('[data-shelf-list-progress="true"]');
  const slot = document.querySelector('[data-shelf-list-source-slot="true"]');
  const sources = document.querySelector('[data-shelf-book-sources="true"]');

  assert.ok(progress);
  assert.ok(slot);
  assert.ok(sources);
  assert.equal(progress.firstElementChild, slot);
  assert.equal(slot.contains(sources), true);
  assert.match(sources.textContent, /304\.7만 조회/);
  assert.doesNotMatch(sources.textContent, /시리즈|카카오|노벨피아|다운로드/);
  assert.match(progress.textContent, /42\.5%/);
});

test('keeps grid source metrics in the card metadata block', () => {
  const document = renderCard('grid');
  const sources = document.querySelector('[data-shelf-book-sources="true"]');

  assert.ok(sources);
  assert.match(sources.textContent, /304\.7만 조회/);
  assert.doesNotMatch(sources.textContent, /시리즈|카카오|노벨피아|다운로드/);
  assert.equal(document.querySelector('[data-shelf-list-progress="true"]'), null);
  assert.equal(document.querySelector('[data-shelf-list-source-slot="true"]'), null);
});

test('orders list title, tags, and time while reserving a centered no-tag state', () => {
  const withTags = renderCard('list');
  const content = withTags.querySelector('[data-shelf-title-tag-group="true"]')?.parentElement;
  const group = withTags.querySelector('[data-shelf-title-tag-group="true"]');
  const transition = withTags.querySelector('[data-shelf-tag-transition="true"]');
  const time = withTags.querySelector('[data-shelf-book-time="true"]');

  assert.ok(content);
  assert.ok(group);
  assert.ok(transition);
  assert.ok(time);
  assert.equal(content.firstElementChild, group);
  assert.equal(group.nextElementSibling, time);
  assert.match(group.className, /min-h-10/);
  assert.match(transition.className, /grid-rows-\[1fr\]/);
  assert.match(transition.className, /duration-300/);

  const withoutTags = renderCard('list', null, { isDownloaded: false });
  const emptyGroup = withoutTags.querySelector('[data-shelf-title-tag-group="true"]');
  const emptyTransition = withoutTags.querySelector('[data-shelf-tag-transition="true"]');
  assert.ok(emptyGroup);
  assert.ok(emptyTransition);
  assert.match(emptyGroup.className, /justify-center/);
  assert.match(emptyTransition.className, /grid-rows-\[0fr\]/);
  assert.equal(emptyTransition.getAttribute('aria-hidden'), 'true');
});

test('keeps every catalog tag in book information after genre', () => {
  const catalog = {
    ...props.catalog,
    tags: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      label: `태그${index + 1}`,
      titleCount: 100 - index,
    })),
  };

  assert.deepEqual(
    getVisibleBookInfoCatalogTags(catalog).map(({ label }) => label),
    ['태그1', '태그2', '태그3', '태그4', '태그5', '태그6', '태그7'],
  );
});

test('offers metadata requests only when tags, genre, and source counts are all absent', () => {
  assert.equal(canRequestPublicBookMetadata(undefined, 'ready', null, 'missing'), true);
  assert.equal(canRequestPublicBookMetadata(undefined, 'loading', null, 'missing'), false);
  assert.equal(canRequestPublicBookMetadata(undefined, 'ready', null, 'error'), false);
  assert.equal(canRequestPublicBookMetadata(props.catalog, 'ready', null, 'missing'), false);
  assert.equal(canRequestPublicBookMetadata({
    ...props.catalog,
    genreLabel: null,
    tags: [],
    record: { ...props.catalog.record, canonicalGenreId: null, tagIds: [], sourceCounts: [null, null, null] },
  }, 'ready', null, 'missing'), true);
  assert.equal(canRequestPublicBookMetadata(undefined, 'ready', {
    platforms: [{ viewCount: 100, downloadCount: null }],
  }, 'ready'), false);
});

test('limits shelf list chips to ten including local and genre and reports the remainder', () => {
  const catalog = {
    ...props.catalog,
    tags: Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      label: `태그${index + 1}`,
      titleCount: 100 - index,
    })),
  };

  const document = renderCard('list', catalog);
  const tags = document.querySelector('[data-shelf-book-tags="true"]');
  assert.ok(tags);
  assert.match(tags.textContent, /^로컬판타지/);
  assert.match(tags.textContent, /태그1/);
  assert.match(tags.textContent, /태그8/);
  assert.doesNotMatch(tags.textContent, /태그9|태그10|태그11|태그12/);
  assert.match(tags.textContent, /\+4/);
  assert.equal(tags.querySelectorAll('span:not([data-shelf-tag-measure-remaining])').length, 11);
  assert.match(tags.className, /flex-nowrap/);
  assert.match(tags.className, /overflow-hidden/);
});

test('fits mobile shelf tags and the remainder into the measured row', () => {
  assert.equal(getFittingShelfTagCount({
    availableWidth: 174,
    genreWidth: 48,
    tagWidths: [40, 52, 44, 50, 48],
    remainderWidths: new Map([[1, 18], [2, 18], [3, 18], [4, 18], [5, 18]]),
    gap: 4,
  }), 2);
  assert.equal(getFittingShelfTagCount({
    availableWidth: 260,
    genreWidth: 48,
    tagWidths: [40, 52, 44, 50, 48],
    remainderWidths: new Map([[1, 18], [2, 18], [3, 18], [4, 18], [5, 18]]),
    gap: 4,
  }), 3);
  assert.equal(getFittingShelfTagCount({
    availableWidth: 260,
    localWidth: 30,
    genreWidth: 48,
    tagWidths: [40, 52, 44, 50, 48],
    remainderWidths: new Map([[1, 18], [2, 18], [3, 18], [4, 18], [5, 18]]),
    gap: 4,
    maxTagCount: 4,
  }), 3);
});

test('shows every shelf grid tag in a two-row clipped viewport', () => {
  const catalog = {
    ...props.catalog,
    tags: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      label: `태그${index + 1}`,
      titleCount: 100 - index,
    })),
  };

  const document = renderCardWithCover('grid', catalog);
  const tags = document.querySelector('[data-shelf-book-tags="true"]');
  const tagViewport = document.querySelector('[data-shelf-grid-cover-tags="true"]');
  assert.ok(tags);
  assert.ok(tagViewport);
  assert.match(tagViewport.className, /max-h-9/);
  assert.match(tagViewport.className, /overflow-hidden/);
  assert.match(tags.textContent, /^로컬판타지/);
  assert.match(tags.textContent, /태그1/);
  assert.match(tags.textContent, /태그2.*태그3.*태그4.*태그5.*태그6.*태그7/);
  assert.doesNotMatch(tags.textContent, /\+\d/);
});
