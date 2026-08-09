import type { Annotation, AnnotationPaletteItem, Book } from '../types';
import { isAnnotation } from './annotationPolicy';
import { isAnnotationPalettePayloadV1 } from './annotationSyncSchema';
import type { LibraryAnnotationIndexEntry } from './annotationQuery';

export const ANNOTATION_EXPORT_FORMAT = 'web-reader-annotations';
export const ANNOTATION_EXPORT_VERSION = 1;

export type AnnotationExportScopeV1 =
  | { kind: 'library' }
  | { kind: 'book'; bookId: string };

export type AnnotationExportV1 = {
  format: typeof ANNOTATION_EXPORT_FORMAT;
  version: typeof ANNOTATION_EXPORT_VERSION;
  exportedAt: number;
  scope: AnnotationExportScopeV1;
  books: Array<Pick<Book, 'id' | 'name'>>;
  palette: AnnotationPaletteItem[];
  annotations: Annotation[];
};

export type AnnotationExportFile = {
  filename: string;
  mimeType: string;
  text: string;
};

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isScopeV1 = (value: unknown): value is AnnotationExportScopeV1 => {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'library') return hasExactKeys(value, ['kind']);
  return value.kind === 'book'
    && hasExactKeys(value, ['kind', 'bookId'])
    && typeof value.bookId === 'string'
    && value.bookId.length > 0;
};

export const isAnnotationExportV1 = (value: unknown): value is AnnotationExportV1 => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'format',
    'version',
    'exportedAt',
    'scope',
    'books',
    'palette',
    'annotations',
  ])) return false;
  if (
    value.format !== ANNOTATION_EXPORT_FORMAT
    || value.version !== ANNOTATION_EXPORT_VERSION
    || !Number.isSafeInteger(value.exportedAt)
    || (value.exportedAt as number) <= 0
    || !isScopeV1(value.scope)
    || !Array.isArray(value.books)
    || !Array.isArray(value.palette)
    || !Array.isArray(value.annotations)
  ) return false;
  if (!isAnnotationPalettePayloadV1({ items: value.palette })) return false;
  if (!value.annotations.every(isAnnotation)) return false;
  const books = value.books as unknown[];
  if (!books.every((book) => (
    isRecord(book)
    && hasExactKeys(book, ['id', 'name'])
    && typeof book.id === 'string'
    && book.id.length > 0
    && typeof book.name === 'string'
    && book.name.length > 0
  ))) return false;
  const bookIds = new Set((books as Array<{ id: string }>).map(({ id }) => id));
  if (bookIds.size !== books.length) return false;
  if (
    value.scope.kind === 'book'
    && (bookIds.size !== 1 || !bookIds.has(value.scope.bookId))
  ) return false;
  const annotationKeys = new Set<string>();
  for (const annotation of value.annotations) {
    if (
      !bookIds.has(annotation.bookId)
      || (value.scope.kind === 'book' && annotation.bookId !== value.scope.bookId)
    ) return false;
    const key = `${annotation.bookId}\u0000${annotation.id}`;
    if (annotationKeys.has(key)) return false;
    annotationKeys.add(key);
  }
  return true;
};

export const parseAnnotationExportV1 = (text: string) => {
  const value: unknown = JSON.parse(text);
  if (!isAnnotationExportV1(value)) {
    throw new TypeError('지원하지 않는 주석 내보내기 형식입니다.');
  }
  return value;
};

const sanitizeFilename = (value: string) => value
  .normalize('NFKC')
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 80) || 'annotations';

const escapeMarkdown = (value: string) => value.replace(/[\\`*_[\]<>#+.!|{}()-]/g, '\\$&');

const quoteMarkdown = (value: string) => value
  .split(/\r?\n/)
  .map((line) => `> ${escapeMarkdown(line)}`)
  .join('\n');

const formatExportDate = (timestamp: number) => new Date(timestamp).toISOString();

const sortedBookEntries = (entries: ReadonlyArray<LibraryAnnotationIndexEntry>) => (
  [...entries].sort((left, right) => (
    (left.book?.name ?? left.annotation.bookId).localeCompare(
      right.book?.name ?? right.annotation.bookId,
      'ko',
    )
    || (left.annotation.progressPercent ?? Number.POSITIVE_INFINITY)
      - (right.annotation.progressPercent ?? Number.POSITIVE_INFINITY)
    || left.annotation.sectionIndex - right.annotation.sectionIndex
    || left.annotation.createdAtClient - right.annotation.createdAtClient
  ))
);

export const createAnnotationMarkdownExport = (
  entries: ReadonlyArray<LibraryAnnotationIndexEntry>,
  palette: ReadonlyArray<AnnotationPaletteItem>,
  options: { exportedAt?: number; title?: string } = {},
): AnnotationExportFile => {
  const exportedAt = options.exportedAt ?? Date.now();
  const paletteById = new Map(palette.map((item) => [item.id, item]));
  const lines = [
    `# ${escapeMarkdown(options.title ?? 'Web Reader 주석')}`,
    '',
    `- 내보낸 시각: ${formatExportDate(exportedAt)}`,
    `- 주석 수: ${entries.length}`,
    '- 포함 정책: 현재 로컬에 존재하는 하이라이트와 메모만 포함하며 삭제 tombstone은 제외합니다. 위치 복원 실패 항목은 상태를 표시한 채 포함합니다.',
  ];
  let previousBookId = '';
  for (const { annotation, book } of sortedBookEntries(entries)) {
    if (annotation.bookId !== previousBookId) {
      previousBookId = annotation.bookId;
      lines.push('', `## ${escapeMarkdown(book?.name ?? `알 수 없는 도서 (${annotation.bookId})`)}`);
    }
    const color = paletteById.get(annotation.colorId);
    const meta = [
      annotation.chapter,
      annotation.progressPercent === null ? '' : `${annotation.progressPercent.toFixed(1)}%`,
      color?.label ?? annotation.colorId,
      color?.meaning ?? '',
      annotation.anchorState === 'unresolved' ? '위치 확인 필요' : '',
    ].filter(Boolean).map(escapeMarkdown).join(' · ');
    lines.push('', `### ${meta || '하이라이트'}`, '', quoteMarkdown(annotation.quote));
    if (annotation.note) {
      lines.push('', '**메모**', '', escapeMarkdown(annotation.note).replace(/\r?\n/g, '  \n'));
    }
    lines.push('', `<small>${formatExportDate(annotation.updatedAtClient)}</small>`);
  }
  const title = options.title ?? (entries.length === 1
    ? entries[0].book?.name ?? 'annotations'
    : 'library-annotations');
  return {
    filename: `${sanitizeFilename(title)}.md`,
    mimeType: 'text/markdown;charset=utf-8',
    text: `${lines.join('\n').trim()}\n`,
  };
};

export const createAnnotationJsonExport = (
  entries: ReadonlyArray<LibraryAnnotationIndexEntry>,
  palette: ReadonlyArray<AnnotationPaletteItem>,
  scope: AnnotationExportScopeV1 = { kind: 'library' },
  exportedAt = Date.now(),
): AnnotationExportFile => {
  const selected = scope.kind === 'book'
    ? entries.filter(({ annotation }) => annotation.bookId === scope.bookId)
    : [...entries];
  const booksById = new Map<string, Pick<Book, 'id' | 'name'>>();
  for (const { annotation, book } of selected) {
    booksById.set(annotation.bookId, {
      id: annotation.bookId,
      name: book?.name ?? `알 수 없는 도서 (${annotation.bookId})`,
    });
  }
  const value: AnnotationExportV1 = {
    format: ANNOTATION_EXPORT_FORMAT,
    version: ANNOTATION_EXPORT_VERSION,
    exportedAt,
    scope,
    books: [...booksById.values()].sort((left, right) => left.name.localeCompare(right.name, 'ko')),
    palette: palette.map((item) => ({ ...item })),
    annotations: sortedBookEntries(selected).map(({ annotation }) => ({ ...annotation })),
  };
  if (!isAnnotationExportV1(value)) throw new TypeError('주석 JSON을 만들 수 없습니다.');
  const scopeName = scope.kind === 'book'
    ? value.books.find(({ id }) => id === scope.bookId)?.name ?? scope.bookId
    : 'library-annotations';
  return {
    filename: `${sanitizeFilename(scopeName)}.json`,
    mimeType: 'application/json;charset=utf-8',
    text: `${JSON.stringify(value, null, 2)}\n`,
  };
};
