import type {
  Annotation,
  AnnotationPaletteItem,
  Book,
  HighlightColorId,
} from '../types';
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

export type LibraryAnnotationSort = 'updated-desc' | 'created-desc' | 'book-reading';

export type LibraryAnnotationIndexEntry = {
  annotation: Annotation;
  book: Pick<Book, 'id' | 'name'> | null;
  searchableText: string;
};

export const buildLibraryAnnotationIndex = (
  annotations: ReadonlyArray<Annotation>,
  books: ReadonlyArray<Pick<Book, 'id' | 'name'>>,
  palette: ReadonlyArray<AnnotationPaletteItem>,
) => {
  const booksById = new Map(books.map((book) => [book.id, book]));
  return annotations.map((annotation): LibraryAnnotationIndexEntry => {
    const book = booksById.get(annotation.bookId) ?? null;
    return {
      annotation,
      book,
      searchableText: [book?.name ?? annotation.bookId, searchableText(annotation, palette)]
        .join('\n')
        .normalize('NFKC')
        .toLocaleLowerCase(),
    };
  });
};

const compareLibraryReadingOrder = (
  left: LibraryAnnotationIndexEntry,
  right: LibraryAnnotationIndexEntry,
) => (
  (left.book?.name ?? left.annotation.bookId).localeCompare(
    right.book?.name ?? right.annotation.bookId,
    'ko',
  )
  || left.annotation.bookId.localeCompare(right.annotation.bookId)
  || readingOrder(left.annotation, right.annotation)
);

export const queryLibraryAnnotationIndex = (
  index: ReadonlyArray<LibraryAnnotationIndexEntry>,
  options: {
    query?: string;
    bookId?: string;
    colorId?: HighlightColorId;
    noteOnly?: boolean;
    sort?: LibraryAnnotationSort;
  } = {},
) => {
  const query = (options.query ?? '').trim().normalize('NFKC').toLocaleLowerCase();
  const filtered = index.filter(({ annotation, searchableText: text }) => (
    (!options.bookId || annotation.bookId === options.bookId)
    && (!options.colorId || annotation.colorId === options.colorId)
    && (!options.noteOnly || annotation.note.trim().length > 0)
    && (!query || text.includes(query))
  ));
  return [...filtered].sort((left, right) => {
    if (options.sort === 'created-desc') {
      return right.annotation.createdAtClient - left.annotation.createdAtClient
        || right.annotation.updatedAtClient - left.annotation.updatedAtClient;
    }
    if (options.sort === 'book-reading') return compareLibraryReadingOrder(left, right);
    return right.annotation.updatedAtClient - left.annotation.updatedAtClient
      || right.annotation.createdAtClient - left.annotation.createdAtClient;
  });
};
