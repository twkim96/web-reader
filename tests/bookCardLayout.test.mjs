import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import bookCardModule from '../src/components/shelf/BookCard.tsx';
import bookUtilsModule from '../src/components/shelf/bookUtils.ts';

const { BookCard, getFittingShelfTagCount } = bookCardModule;
const { canRequestPublicBookMetadata, getVisibleBookInfoCatalogTags } = bookUtilsModule;

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

const renderCard = (viewMode, catalog = props.catalog) => {
  const html = renderToStaticMarkup(React.createElement(BookCard, {
    ...props,
    catalog,
    viewMode,
  }));
  return parseHTML(html).document;
};

const renderCardWithCover = (viewMode) => {
  const html = renderToStaticMarkup(React.createElement(BookCard, {
    ...props,
    viewMode,
    coverUrl: 'blob:https://reader.test/cached-cover',
  }));
  return parseHTML(html).document;
};

test('replaces the grid and list book icon only when a cached cover exists', () => {
  for (const viewMode of ['grid', 'list']) {
    const covered = renderCardWithCover(viewMode);
    assert.ok(covered.querySelector('[data-shelf-book-cover="true"]'));
    assert.equal(covered.querySelector('[data-shelf-book-icon="true"]'), null);

    const fallback = renderCard(viewMode);
    assert.equal(fallback.querySelector('[data-shelf-book-cover="true"]'), null);
    assert.ok(fallback.querySelector('[data-shelf-book-icon="true"]'));
  }
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

  const withoutTags = renderCard('list', null);
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

test('limits shelf list tags to five and reports the remainder', () => {
  const catalog = {
    ...props.catalog,
    tags: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      label: `태그${index + 1}`,
      titleCount: 100 - index,
    })),
  };

  const document = renderCard('list', catalog);
  const tags = document.querySelector('[data-shelf-book-tags="true"]');
  assert.ok(tags);
  assert.match(tags.textContent, /태그1/);
  assert.match(tags.textContent, /태그5/);
  assert.doesNotMatch(tags.textContent, /태그6|태그7/);
  assert.match(tags.textContent, /\+2/);
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
});

test('shows every shelf grid tag', () => {
  const catalog = {
    ...props.catalog,
    tags: Array.from({ length: 7 }, (_, index) => ({
      id: index + 1,
      label: `태그${index + 1}`,
      titleCount: 100 - index,
    })),
  };

  const document = renderCard('grid', catalog);
  const tags = document.querySelector('[data-shelf-book-tags="true"]');
  assert.ok(tags);
  assert.match(tags.textContent, /태그1/);
  assert.match(tags.textContent, /태그2.*태그3.*태그4.*태그5.*태그6.*태그7/);
  assert.doesNotMatch(tags.textContent, /\+\d/);
});
