'use client';

export interface RelocateDetail {
  cfi: string;
  anchorCfi?: string;
  fraction: number;
  progressPercent?: number;
  location: {
    current: number;
    next: number;
    total: number;
  };
  section?: {
    current: number;
    total: number;
  };
  tocItem?: {
    label: string;
    href: string;
  };
  range?: Range;
  index?: number;
}

export type FoliateSection = {
  id?: string | number;
  href?: string;
  linear?: string;
  size?: number;
  load?: (signal?: AbortSignal) => Promise<string> | string;
};

export type TocItem = {
  label?: string;
  href: string;
  progress?: number;
  subitems?: TocItem[];
};

export type FoliateBook = {
  sections: FoliateSection[];
  toc?: TocItem[];
  metadata?: { title?: string };
  rendition?: {
    layout?: string;
    spread?: string;
  };
  resolveHref: (href: string) => { index: number };
  splitTOCHref?: (href: string) => [string, unknown];
  getTOCFragment?: (doc: Document, fragment?: unknown) => Node;
  destroy?: () => void;
};

export type FoliateRenderer = {
  start: number;
  viewSize: number;
  size: number;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value?: string) => void;
  setStyles: (styles: string[]) => void;
  getContents?: () => { doc?: Document }[];
};

export type SearchSubitem = {
  cfi: string;
  excerpt: string | { pre: string; match: string; post: string };
};

export type FoliateSearchResult = 'done' | {
  progress?: number;
  label?: string;
  index?: number;
  subitems?: SearchSubitem[];
};

export type FoliateViewElement = HTMLElement & {
  renderer?: FoliateRenderer;
  book?: {
    sections?: FoliateSection[];
    toc?: TocItem[];
  };
  open: (source: Blob | File | string | FoliateBook) => Promise<void>;
  init: (options: { lastLocation: string | null }) => Promise<void>;
  prev: (distance?: number) => void;
  next: (distance?: number) => void;
  goTo: (cfi: string) => Promise<void>;
  goToFraction: (fraction: number) => Promise<void>;
  resolveNavigation: (href: string) => { index?: number } | null;
  search: (options: { query: string }) => AsyncIterable<FoliateSearchResult>;
  clearSearch?: () => void;
  close?: () => void;
};

export type ReaderStyle = {
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  fontFamily?: string;
  textAlign?: string;
  bgColor?: string;
  textColor?: string;
  bgImage?: string;
  bgSize?: string;
};

export type ReaderLayout = {
  flow?: 'paginated' | 'scrolled';
  margin?: number;
  gap?: string;
  maxColumnCount?: number;
  maxInlineSize?: string;
  animated?: boolean;
};

export type SearchResultPayload = {
  label: string;
  index: number;
  total: number;
  progress: number;
  subitems: SearchSubitem[];
};
