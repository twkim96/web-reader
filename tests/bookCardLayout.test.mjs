import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import bookCardModule from '../src/components/shelf/BookCard.tsx';

const { BookCard } = bookCardModule;

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

const renderCard = (viewMode) => {
  const html = renderToStaticMarkup(React.createElement(BookCard, {
    ...props,
    viewMode,
  }));
  return parseHTML(html).document;
};

test('places list source metrics above the progress percentage', () => {
  const document = renderCard('list');
  const progress = document.querySelector('[data-shelf-list-progress="true"]');
  const slot = document.querySelector('[data-shelf-list-source-slot="true"]');
  const sources = document.querySelector('[data-shelf-book-sources="true"]');

  assert.ok(progress);
  assert.ok(slot);
  assert.ok(sources);
  assert.equal(progress.firstElementChild, slot);
  assert.equal(slot.contains(sources), true);
  assert.match(sources.textContent, /시리즈 166\.9만 다운로드/);
  assert.match(sources.textContent, /카카오 137\.8만 조회/);
  assert.match(progress.textContent, /42\.5%/);
});

test('keeps grid source metrics in the card metadata block', () => {
  const document = renderCard('grid');

  assert.ok(document.querySelector('[data-shelf-book-sources="true"]'));
  assert.equal(document.querySelector('[data-shelf-list-progress="true"]'), null);
  assert.equal(document.querySelector('[data-shelf-list-source-slot="true"]'), null);
});
