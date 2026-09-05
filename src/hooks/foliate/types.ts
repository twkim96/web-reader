'use client';

export interface RelocateDetail {
  cfi: string;
  reason?: string;
  navigationSource?: string;
  navigationId?: string;
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
  getCover?: () => Promise<Blob | null>;
  destroy?: () => void;
};

export type FoliateRenderer = {
  start: number;
  viewSize: number;
  size: number;
  userScale?: number;
  baseScale?: number;
  effectiveScale?: number;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value?: string) => void;
  setStyles: (styles: string[]) => void;
  waitForNavigationReady?: (timeoutMs?: number) => Promise<boolean>;
  getContents?: () => {
    index?: number;
    doc?: Document;
    overlayer?: { element?: Element };
  }[];
  setUserScale?: (
    value: number,
    focalPoint?: { x: number; y: number },
    options?: { preview?: boolean },
  ) => number;
  adjustUserScale?: (factor: number, focalPoint?: { x: number; y: number }) => number;
  commitUserScale?: () => number;
  panBy?: (deltaX: number, deltaY: number) => { scrollLeft: number; scrollTop: number };
  resetUserScale?: () => number;
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
  lastLocation?: RelocateDetail;
  renderer?: FoliateRenderer;
  book?: {
    sections?: FoliateSection[];
    toc?: TocItem[];
    getCover?: () => Promise<Blob | null>;
  };
  open: (source: Blob | File | string | FoliateBook) => Promise<void>;
  init: (options: { lastLocation: string | null }) => Promise<void>;
  prev: (distance?: number) => void;
  next: (distance?: number) => void;
  waitForNavigationReady?: (timeoutMs?: number) => Promise<boolean>;
  goTo: (cfi: string) => Promise<false | {
    index?: number;
    anchor?: Range | ((doc: Document) => Range | Element | number);
  }>;
  goToStable?: (cfi: string) => Promise<false | {
    index?: number;
    anchor?: Range | ((doc: Document) => Range | Element | number);
  }>;
  goToFraction: (fraction: number) => Promise<boolean>;
  goToFractionStable?: (fraction: number) => Promise<boolean>;
  navigateTransient: (
    target: string | number | {
      index: number;
      range?: Range;
      anchor?: Range | ((doc: Document) => Range | Element | number);
    },
    reason: string,
  ) => Promise<unknown>;
  cancelTransientNavigation?: (source?: string) => boolean | undefined;
  resolveNavigation: (href: string) => {
    index?: number;
    anchor?: Range | ((doc: Document) => Range | Element | number);
  } | null;
  search: (options: { query: string; signal?: AbortSignal }) => AsyncIterable<FoliateSearchResult>;
  clearSearch?: () => void;
  getCFI: (index: number, range?: Range) => string;
  addAnnotation: (annotation: FoliateAnnotationPayload) => Promise<{
    index: number;
    label: string;
  } | undefined>;
  deleteAnnotation: (annotation: FoliateAnnotationPayload) => Promise<unknown>;
  addTransientOverlay: (overlay: FoliateTransientOverlay) => boolean;
  removeTransientOverlay: (overlay: Pick<FoliateTransientOverlay, 'key' | 'index'>) => boolean;
  close?: () => void;
};

export type FoliateAnnotationPayload = {
  value: string;
  annotationId: string;
};

export type FoliateTransientOverlay = {
  key: object;
  index: number;
  range: Range;
  draw: (
    rects: DOMRectList,
    options: { color: string; interactive?: boolean },
  ) => SVGElement;
  options: { color: string; interactive?: boolean };
};

export type FoliateDrawAnnotationDetail = {
  annotation: FoliateAnnotationPayload;
  doc: Document;
  range: Range;
  draw: (
    renderer: (
      rects: DOMRectList,
      options: { color: string; interactive?: boolean },
    ) => SVGElement,
    options: { color: string; interactive?: boolean },
  ) => void;
};

export type FoliateShowAnnotationDetail = {
  value: string;
  index: number;
  range: Range;
};

export type FoliateCreateOverlayDetail = {
  index: number;
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
  swipeNavigation?: boolean;
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
