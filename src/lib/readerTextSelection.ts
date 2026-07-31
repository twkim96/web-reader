export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type FrameMetrics = {
  rect: RectLike;
  clientWidth: number;
  clientHeight: number;
};

export type ViewportPoint = {
  x: number;
  y: number;
};

export type SelectionViewportAnchor = {
  x: number;
  top: number;
  bottom: number;
};

export const getDocumentFrameMetrics = (doc: Document): FrameMetrics | null => {
  const frame = doc.defaultView?.frameElement as HTMLElement | null;
  if (!frame || typeof frame.getBoundingClientRect !== 'function') return null;
  return {
    rect: frame.getBoundingClientRect(),
    clientWidth: frame.clientWidth,
    clientHeight: frame.clientHeight,
  };
};

const isUsableRect = (rect: RectLike) => (
  Number.isFinite(rect.left)
  && Number.isFinite(rect.top)
  && Number.isFinite(rect.right)
  && Number.isFinite(rect.bottom)
  && rect.width > 0
  && rect.height > 0
);

const intersectsViewport = (
  rect: RectLike,
  viewportWidth: number,
  viewportHeight: number,
) => (
  rect.right > 0
  && rect.bottom > 0
  && rect.left < viewportWidth
  && rect.top < viewportHeight
);

export const pickSelectionAnchorRect = (
  rects: RectLike[],
  viewportWidth: number,
  viewportHeight: number,
): RectLike | null => {
  const usable = rects.filter(isUsableRect);
  if (usable.length === 0) return null;

  const visible = usable.filter((rect) => (
    intersectsViewport(rect, viewportWidth, viewportHeight)
  ));
  return visible.at(-1) ?? usable.at(-1) ?? null;
};

const getScale = (renderedSize: number, clientSize: number) => (
  clientSize > 0 && Number.isFinite(renderedSize / clientSize)
    ? renderedSize / clientSize
    : 1
);

export const mapFrameClientPoint = (
  point: ViewportPoint,
  frame: FrameMetrics | null,
): ViewportPoint => {
  if (!frame) return point;
  const scaleX = getScale(frame.rect.width, frame.clientWidth);
  const scaleY = getScale(frame.rect.height, frame.clientHeight);
  return {
    x: frame.rect.left + point.x * scaleX,
    y: frame.rect.top + point.y * scaleY,
  };
};

export const mapFrameRectToViewport = (
  rect: RectLike,
  frame: FrameMetrics | null,
): RectLike => {
  const topLeft = mapFrameClientPoint({ x: rect.left, y: rect.top }, frame);
  const bottomRight = mapFrameClientPoint({ x: rect.right, y: rect.bottom }, frame);
  return {
    left: topLeft.x,
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
};

export const mapSelectionRectToViewport = (
  rect: RectLike,
  frame: FrameMetrics | null,
): SelectionViewportAnchor => {
  const mapped = mapFrameRectToViewport(rect, frame);
  return {
    x: (mapped.left + mapped.right) / 2,
    top: mapped.top,
    bottom: mapped.bottom,
  };
};

export const getRangeViewportAnchor = (
  range: Range,
  frame: FrameMetrics | null,
  viewportWidth: number,
  viewportHeight: number,
) => {
  const rects = (Array.from(range.getClientRects()) as RectLike[])
    .map((rect) => mapFrameRectToViewport(rect, frame));
  const anchorRect = pickSelectionAnchorRect(rects, viewportWidth, viewportHeight);
  return anchorRect ? mapSelectionRectToViewport(anchorRect, null) : null;
};

export const getRangeTextContext = (
  range: Range,
  root: Node,
  limit = 80,
) => {
  try {
    const before = range.cloneRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    const after = range.cloneRange();
    after.selectNodeContents(root);
    after.setStart(range.endContainer, range.endOffset);
    return {
      prefix: before.toString().slice(-limit),
      suffix: after.toString().slice(0, limit),
    };
  } catch {
    return { prefix: '', suffix: '' };
  }
};

export const hasNonCollapsedSelection = (selection: Selection | null) => (
  Boolean(selection && selection.rangeCount > 0 && !selection.isCollapsed && selection.toString().trim())
);

export const isSelectionRelocateReason = (reason?: string) => (
  reason === 'selection'
  || reason === 'selection-page'
  || reason === 'selection-anchor'
);

export const isPublicationLinkTarget = (target: EventTarget | null) => {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  return typeof candidate?.closest === 'function'
    && Boolean(candidate.closest('a[href]'));
};
