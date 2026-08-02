import type { Annotation, AnnotationPaletteItem, HighlightColorId } from '../types';
import { HIGHLIGHT_COLORS } from './annotationPolicy';
import { getAnnotationPaletteItem } from './annotationPalette';

export type AnnotationSort = 'reading' | 'created-desc' | 'updated-desc';

const searchableText = (
  annotation: Annotation,
  palette: ReadonlyArray<AnnotationPaletteItem>,
) => {
  const color = getAnnotationPaletteItem(palette, annotation.colorId);
  return [annotation.quote, annotation.note, annotation.chapter, color.label, color.meaning]
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase();
};

const readingOrder = (a: Annotation, b: Annotation) => {
  const aProgress = a.progressPercent ?? Number.POSITIVE_INFINITY;
  const bProgress = b.progressPercent ?? Number.POSITIVE_INFINITY;
  return aProgress - bProgress
    || a.sectionIndex - b.sectionIndex
    || a.createdAtClient - b.createdAtClient
    || a.id.localeCompare(b.id);
};

export const queryAnnotations = (
  annotations: ReadonlyArray<Annotation>,
  palette: ReadonlyArray<AnnotationPaletteItem>,
  options: {
    query?: string;
    noteOnly?: boolean;
    sort?: AnnotationSort;
  } = {},
) => {
  const query = (options.query ?? '').trim().normalize('NFKC').toLocaleLowerCase();
  const filtered = annotations.filter((annotation) => (
    (!options.noteOnly || annotation.note.trim().length > 0)
    && (!query || searchableText(annotation, palette).includes(query))
  ));
  return [...filtered].sort((a, b) => {
    if (options.sort === 'created-desc') {
      return b.createdAtClient - a.createdAtClient || b.updatedAtClient - a.updatedAtClient;
    }
    if (options.sort === 'updated-desc') {
      return b.updatedAtClient - a.updatedAtClient || b.createdAtClient - a.createdAtClient;
    }
    return readingOrder(a, b);
  });
};

export const groupAnnotationsByColor = (
  annotations: ReadonlyArray<Annotation>,
) => HIGHLIGHT_COLORS.map(({ id }) => ({
  colorId: id as HighlightColorId,
  annotations: annotations.filter((annotation) => annotation.colorId === id),
}));
