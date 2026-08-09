const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export const createReaderTtsOverlayKey = () => ({ readerTtsOverlay: true });

export const drawReaderTtsRects = (rects: DOMRectList) => {
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('fill', '#38bdf8');
  group.setAttribute('opacity', '0.24');
  group.setAttribute('pointer-events', 'none');
  group.setAttribute('data-reader-tts-highlight', 'true');
  for (const { left, top, height, width } of Array.from(rects)) {
    if (width <= 0 || height <= 0) continue;
    const rectangle = document.createElementNS(SVG_NAMESPACE, 'rect');
    rectangle.setAttribute('x', String(left));
    rectangle.setAttribute('y', String(top));
    rectangle.setAttribute('height', String(height));
    rectangle.setAttribute('width', String(width));
    rectangle.setAttribute('rx', '2');
    group.append(rectangle);
  }
  return group;
};
