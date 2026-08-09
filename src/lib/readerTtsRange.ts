import {
  segmentReaderTtsText,
  type ReaderTtsTextSegment,
} from './readerTts.ts';

export type ReaderTtsRangeSegment = {
  text: string;
  range: Range;
  sourceIndex: number;
  sourceStart: number;
  sourceEnd: number;
};

export type ReaderTtsRangeQueue = {
  segments: ReaderTtsRangeSegment[];
  initialIndex: number;
};

type ReaderTtsTextRun = {
  node: Text;
  nodeStart: number;
  nodeEnd: number;
  start: number;
  end: number;
};

export type ReaderTtsRangeSource = {
  doc: Document;
  runs: ReaderTtsTextRun[];
  sourceLength: number;
  segments: ReaderTtsTextSegment[];
};

const blockedTextSelector = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'rt',
  'rp',
  '[hidden]',
  '[aria-hidden="true"]',
].join(',');

const blockSelector = [
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section',
  'table', 'tr', 'td', 'th', 'dt', 'dd', 'ul',
].join(',');

const isElementTextVisible = (
  element: Element,
  cache: WeakMap<Element, boolean>,
): boolean => {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  const parent = element.parentElement;
  const parentVisible = !parent || isElementTextVisible(parent, cache);
  if (!parentVisible || element.matches(blockedTextSelector)) {
    cache.set(element, false);
    return false;
  }
  const style = element.ownerDocument.defaultView?.getComputedStyle?.(element);
  const visible = !style
    || (
      style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.visibility !== 'collapse'
      && style.getPropertyValue('content-visibility') !== 'hidden'
    );
  cache.set(element, visible);
  return visible;
};

const canUseTextNode = (
  node: Text,
  visibilityCache: WeakMap<Element, boolean>,
) => {
  const parent = node.parentElement;
  return Boolean(
    parent
    && node.data.length > 0
    && isElementTextVisible(parent, visibilityCache)
  );
};

const intersectsRange = (range: Range | undefined, node: Node) => {
  if (!range) return true;
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
};

const getScopedOffsets = (node: Text, scopeRange?: Range) => {
  let start = 0;
  let end = node.data.length;
  if (scopeRange?.startContainer === node) start = scopeRange.startOffset;
  if (scopeRange?.endContainer === node) end = scopeRange.endOffset;
  return {
    start: Math.min(end, Math.max(0, start)),
    end: Math.max(start, Math.min(node.data.length, end)),
  };
};

const collectTextRuns = (doc: Document, scopeRange?: Range) => {
  const root = doc.body || doc.documentElement;
  const nodeFilter = doc.defaultView?.NodeFilter;
  const showElement = nodeFilter?.SHOW_ELEMENT ?? 1;
  const showText = nodeFilter?.SHOW_TEXT ?? 4;
  const filterAccept = nodeFilter?.FILTER_ACCEPT ?? 1;
  const filterReject = nodeFilter?.FILTER_REJECT ?? 2;
  const visibilityCache = new WeakMap<Element, boolean>();
  const walker = doc.createTreeWalker(root, showElement | showText, {
    acceptNode: (node) => {
      if (!intersectsRange(scopeRange, node)) return filterReject;
      if (node.nodeType === 1) {
        return isElementTextVisible(node as Element, visibilityCache)
          ? filterAccept
          : filterReject;
      }
      return canUseTextNode(node as Text, visibilityCache)
        ? filterAccept
        : filterReject;
    },
  });
  const runs: ReaderTtsTextRun[] = [];
  let source = '';
  const appendSeparator = (separator: string) => {
    if (!source || /\s$/u.test(source)) return;
    source += separator;
  };
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === 1) {
      const element = walker.currentNode as Element;
      if (element.localName === 'br') appendSeparator('\n');
      else if (element.matches(blockSelector)) appendSeparator('\n');
      continue;
    }
    const node = walker.currentNode as Text;
    const offsets = getScopedOffsets(node, scopeRange);
    if (offsets.start >= offsets.end) continue;
    const start = source.length;
    source += node.data.slice(offsets.start, offsets.end);
    runs.push({
      node,
      nodeStart: offsets.start,
      nodeEnd: offsets.end,
      start,
      end: source.length,
    });
  }
  return { runs, source };
};

const toDomOffset = (run: ReaderTtsTextRun, sourceOffset: number) => (
  run.nodeStart + Math.min(
    run.nodeEnd - run.nodeStart,
    Math.max(0, sourceOffset - run.start),
  )
);

const createRangeSegment = (
  doc: Document,
  runs: ReaderTtsTextRun[],
  segment: { text: string; start: number; end: number },
): Omit<ReaderTtsRangeSegment, 'sourceIndex' | 'sourceStart' | 'sourceEnd'> | null => {
  const first = runs.find((run) => run.end > segment.start && run.start < segment.end);
  const last = [...runs].reverse().find((run) => (
    run.start < segment.end && run.end > segment.start
  ));
  if (!first || !last) return null;
  const range = doc.createRange();
  range.setStart(first.node, toDomOffset(first, segment.start));
  range.setEnd(last.node, toDomOffset(last, segment.end));
  return range.collapsed ? null : { text: segment.text, range };
};

const getAnchorOffset = (
  doc: Document,
  runs: ReaderTtsTextRun[],
  sourceLength: number,
  anchorRange?: Range,
) => {
  if (!anchorRange) return 0;
  const direct = runs.find(({ node }) => node === anchorRange.startContainer);
  if (direct) {
    return direct.start + Math.min(
      direct.nodeEnd - direct.nodeStart,
      Math.max(0, anchorRange.startOffset - direct.nodeStart),
    );
  }
  try {
    const marker = anchorRange.cloneRange();
    marker.collapse(true);
    const startToStart = doc.defaultView?.Range.START_TO_START ?? 0;
    for (const run of runs) {
      const runRange = doc.createRange();
      runRange.setStart(run.node, run.nodeStart);
      runRange.collapse(true);
      if (marker.compareBoundaryPoints(startToStart, runRange) <= 0) return run.start;
    }
  } catch {
    return null;
  }
  return sourceLength;
};

export const createReaderTtsRangeSource = ({
  doc,
  scopeRange,
  locale,
}: {
  doc: Document;
  scopeRange?: Range;
  locale?: string;
}): ReaderTtsRangeSource => {
  const { runs, source } = collectTextRuns(doc, scopeRange);
  return {
    doc,
    runs,
    sourceLength: source.length,
    segments: runs.length === 0 || !source.trim()
      ? []
      : segmentReaderTtsText(source, locale),
  };
};

export const resolveReaderTtsSourceAnchorIndex = (
  source: ReaderTtsRangeSource,
  anchorRange?: Range,
) => {
  if (source.segments.length === 0) return null;
  const anchorOffset = getAnchorOffset(
    source.doc,
    source.runs,
    source.sourceLength,
    anchorRange,
  );
  if (anchorOffset === null) return null;
  const foundIndex = source.segments.findIndex(({ end }) => end > anchorOffset);
  return foundIndex < 0 ? source.segments.length - 1 : foundIndex;
};

export const createReaderTtsRangeWindow = ({
  source,
  anchorRange,
  startIndex,
  maxSegments,
  windowBefore = 0,
}: {
  source: ReaderTtsRangeSource;
  anchorRange?: Range;
  startIndex?: number;
  maxSegments?: number;
  windowBefore?: number;
}): ReaderTtsRangeQueue => {
  if (source.segments.length === 0) return { segments: [], initialIndex: 0 };
  const anchorIndex = startIndex === undefined
    ? resolveReaderTtsSourceAnchorIndex(source, anchorRange)
    : Math.floor(startIndex);
  if (
    anchorIndex === null
    || anchorIndex < 0
    || anchorIndex >= source.segments.length
  ) return { segments: [], initialIndex: 0 };
  const safeMaximum = maxSegments && Number.isFinite(maxSegments)
    ? Math.max(1, Math.floor(maxSegments))
    : source.segments.length;
  const safeWindowBefore = Math.min(
    safeMaximum - 1,
    Math.max(0, Math.floor(windowBefore)),
  );
  let sliceStart = Math.max(0, anchorIndex - safeWindowBefore);
  const sliceEnd = Math.min(source.segments.length, sliceStart + safeMaximum);
  if (safeWindowBefore > 0) sliceStart = Math.max(0, sliceEnd - safeMaximum);
  const segments = source.segments
    .slice(sliceStart, sliceEnd)
    .map((segment, index) => ({
      source: segment,
      mapped: createRangeSegment(source.doc, source.runs, segment),
      sourceIndex: sliceStart + index,
    }))
    .filter((item): item is {
      source: { text: string; start: number; end: number };
      mapped: ReaderTtsRangeSegment;
      sourceIndex: number;
    } => Boolean(item.mapped));
  if (segments.length === 0) return { segments: [], initialIndex: 0 };
  const mappedAnchorIndex = segments.findIndex(({ sourceIndex }) => sourceIndex >= anchorIndex);
  const initialIndex = mappedAnchorIndex < 0 ? segments.length - 1 : mappedAnchorIndex;
  return {
    segments: segments.map(({ mapped, source: sourceSegment, sourceIndex }) => ({
      ...mapped,
      sourceIndex,
      sourceStart: sourceSegment.start,
      sourceEnd: sourceSegment.end,
    })),
    initialIndex,
  };
};

export const createReaderTtsRangeQueue = ({
  doc,
  scopeRange,
  anchorRange,
  locale,
  maxSegments,
  windowBefore = 0,
}: {
  doc: Document;
  scopeRange?: Range;
  anchorRange?: Range;
  locale?: string;
  maxSegments?: number;
  windowBefore?: number;
}): ReaderTtsRangeQueue => createReaderTtsRangeWindow({
  source: createReaderTtsRangeSource({ doc, scopeRange, locale }),
  anchorRange,
  maxSegments,
  windowBefore,
});

export const findVisibleReaderTtsAnchor = (doc: Document) => {
  const root = doc.body || doc.documentElement;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(root, showText);
  const viewportWidth = doc.defaultView?.innerWidth ?? Number.MAX_SAFE_INTEGER;
  const viewportHeight = doc.defaultView?.innerHeight ?? Number.MAX_SAFE_INTEGER;
  const visibilityCache = new WeakMap<Element, boolean>();
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!canUseTextNode(node, visibilityCache) || !node.data.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    const visible = Array.from(range.getClientRects()).find((rect) => (
      rect.width > 0
      && rect.height > 0
      && rect.right > 0
      && rect.bottom > 0
      && rect.left < viewportWidth
      && rect.top < viewportHeight
    ));
    if (!visible) continue;
    range.setEnd(node, 0);
    return range;
  }
  return null;
};
