import type {
  Annotation,
  AnnotationAnchorState,
  HighlightColorId,
} from '../types';

export const HIGHLIGHT_COLORS: ReadonlyArray<{
  id: HighlightColorId;
  label: string;
  color: string;
}> = [
  { id: 'yellow', label: '노랑', color: '#facc15' },
  { id: 'green', label: '초록', color: '#4ade80' },
  { id: 'blue', label: '파랑', color: '#60a5fa' },
  { id: 'pink', label: '분홍', color: '#f472b6' },
  { id: 'purple', label: '보라', color: '#c084fc' },
];

export const ANNOTATION_BOOK_LIMIT = 100;
export const ANNOTATION_COLOR_LIMIT = 20;
export const ANNOTATION_CONTEXT_LENGTH = 80;
export const ANNOTATION_QUOTE_MAX_LENGTH = 4000;
export const ANNOTATION_NOTE_MAX_LENGTH = 4000;
export const ANNOTATION_RANGE_CFI_MAX_LENGTH = 16000;
export const ANNOTATION_BOOK_DELETE_MARKER_ID = 'book_delete_marker_v1';

const colorIds = new Set(HIGHLIGHT_COLORS.map(({ id }) => id));
const anchorStates = new Set<AnnotationAnchorState>(['active', 'unresolved']);
const epubCfiWrapperPattern = /^epubcfi\(.+\)$/;
const annotationIdPattern = /^[A-Za-z0-9_-]+$/;

export const normalizeAnnotationText = (value: string) => value
  .replace(/\s+/g, ' ')
  .trim();

export const isHighlightColorId = (value: unknown): value is HighlightColorId => (
  typeof value === 'string' && colorIds.has(value as HighlightColorId)
);

export const isAnnotation = (value: unknown): value is Annotation => {
  if (!value || typeof value !== 'object') return false;
  const annotation = value as Partial<Annotation>;
  return typeof annotation.id === 'string'
    && annotation.id.length > 0
    && annotation.id.length <= 128
    && annotationIdPattern.test(annotation.id)
    && annotation.id !== ANNOTATION_BOOK_DELETE_MARKER_ID
    && typeof annotation.bookId === 'string'
    && annotation.bookId.length > 0
    && annotation.bookId.length <= 512
    && annotation.type === 'highlight'
    && typeof annotation.sectionIndex === 'number'
    && Number.isSafeInteger(annotation.sectionIndex)
    && annotation.sectionIndex >= 0
    && typeof annotation.rangeCfi === 'string'
    && epubCfiWrapperPattern.test(annotation.rangeCfi)
    && annotation.rangeCfi.length <= ANNOTATION_RANGE_CFI_MAX_LENGTH
    && typeof annotation.quote === 'string'
    && normalizeAnnotationText(annotation.quote).length > 0
    && annotation.quote.length <= ANNOTATION_QUOTE_MAX_LENGTH
    && typeof annotation.prefix === 'string'
    && annotation.prefix.length <= ANNOTATION_CONTEXT_LENGTH
    && typeof annotation.suffix === 'string'
    && annotation.suffix.length <= ANNOTATION_CONTEXT_LENGTH
    && isHighlightColorId(annotation.colorId)
    && typeof annotation.note === 'string'
    && annotation.note.length <= ANNOTATION_NOTE_MAX_LENGTH
    && (
      annotation.progressPercent === null
      || typeof annotation.progressPercent === 'number'
      && Number.isFinite(annotation.progressPercent)
      && annotation.progressPercent >= 0
      && annotation.progressPercent <= 100
    )
    && typeof annotation.chapter === 'string'
    && annotation.chapter.length <= 500
    && typeof annotation.createdAtClient === 'number'
    && Number.isSafeInteger(annotation.createdAtClient)
    && annotation.createdAtClient > 0
    && typeof annotation.updatedAtClient === 'number'
    && Number.isSafeInteger(annotation.updatedAtClient)
    && annotation.updatedAtClient >= annotation.createdAtClient
    && typeof annotation.anchorState === 'string'
    && anchorStates.has(annotation.anchorState as AnnotationAnchorState);
};

export const verifyAnnotationAnchor = (
  annotation: Pick<Annotation, 'quote' | 'prefix' | 'suffix'>,
  actual: Pick<Annotation, 'quote' | 'prefix' | 'suffix'>,
) => (
  normalizeAnnotationText(annotation.quote) === normalizeAnnotationText(actual.quote)
  && normalizeAnnotationText(annotation.prefix) === normalizeAnnotationText(actual.prefix)
  && normalizeAnnotationText(annotation.suffix) === normalizeAnnotationText(actual.suffix)
);

export const getHighlightColor = (colorId: HighlightColorId) => (
  HIGHLIGHT_COLORS.find(({ id }) => id === colorId) ?? HIGHLIGHT_COLORS[0]
);
