import type { Annotation } from '../types';
import type { FoliateAnnotationPayload } from '../hooks/foliate/types';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export const toFoliateAnnotation = (
  annotation: Annotation,
): FoliateAnnotationPayload => ({
  value: annotation.rangeCfi,
  annotationId: annotation.id,
});

export const drawHighlightRects = (
  rects: DOMRectList,
  { color }: { color: string },
) => {
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('fill', color);
  group.setAttribute('opacity', '0.34');
  group.setAttribute('data-reader-highlight', 'true');
  for (const { left, top, height, width } of Array.from(rects)) {
    if (width <= 0 || height <= 0) continue;
    const rectangle = document.createElementNS(SVG_NAMESPACE, 'rect');
    rectangle.setAttribute('x', String(left));
    rectangle.setAttribute('y', String(top));
    rectangle.setAttribute('height', String(height));
    rectangle.setAttribute('width', String(width));
    group.append(rectangle);
  }
  return group;
};
