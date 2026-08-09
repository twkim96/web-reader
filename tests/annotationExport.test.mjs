import test from 'node:test';
import assert from 'node:assert/strict';

const { buildLibraryAnnotationIndex } = await import('../src/lib/annotationQuery.ts');
const {
  createAnnotationJsonExport,
  createAnnotationMarkdownExport,
  parseAnnotationExportV1,
} = await import('../src/lib/annotationExport.ts');
const { DEFAULT_ANNOTATION_PALETTE } = await import('../src/lib/annotationPalette.ts');

const annotation = (id, overrides = {}) => ({
  id,
  bookId: 'book-1',
  type: 'highlight',
  sectionIndex: 1,
  rangeCfi: `epubcfi(/6/4!/4/2,/1:0,/1:${id.length + 1})`,
  quote: '“인용”\n*기호*와 😀 emoji',
  prefix: '앞 문맥',
  suffix: '뒤 문맥',
  colorId: 'yellow',
  note: '첫 줄\n# 메모 [링크]',
  progressPercent: 12.5,
  chapter: '1장 #시작',
  createdAtClient: 1,
  updatedAtClient: 2,
  anchorState: 'unresolved',
  ...overrides,
});

test('exports readable Markdown without losing quotes, line breaks, symbols, or emoji', () => {
  const source = annotation('special');
  const index = buildLibraryAnnotationIndex(
    [source],
    [{ id: 'book-1', name: '책 *제목*' }],
    DEFAULT_ANNOTATION_PALETTE,
  );
  const result = createAnnotationMarkdownExport(index, DEFAULT_ANNOTATION_PALETTE, {
    exportedAt: 1_700_000_000_000,
    title: '책 *제목*',
  });
  assert.equal(result.filename, '책 _제목_.md');
  assert.ok(result.text.includes('> “인용”\n> \\*기호\\*와 😀 emoji'));
  assert.ok(result.text.includes('첫 줄  \n\\# 메모 \\[링크\\]'));
  assert.match(result.text, /위치 확인 필요/);
});

test('round-trips every annotation field through versioned JSON', () => {
  const source = annotation('json');
  const index = buildLibraryAnnotationIndex(
    [source],
    [{ id: 'book-1', name: 'JSON 책' }],
    DEFAULT_ANNOTATION_PALETTE,
  );
  const result = createAnnotationJsonExport(
    index,
    DEFAULT_ANNOTATION_PALETTE,
    { kind: 'library' },
    1_700_000_000_000,
  );
  const parsed = parseAnnotationExportV1(result.text);
  assert.equal(parsed.format, 'web-reader-annotations');
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.annotations, [source]);
  assert.deepEqual(parsed.palette, DEFAULT_ANNOTATION_PALETTE);
});

test('keeps orphan annotations exportable and rejects unknown JSON fields', () => {
  const source = annotation('orphan', { bookId: 'missing-book' });
  const index = buildLibraryAnnotationIndex([source], [], DEFAULT_ANNOTATION_PALETTE);
  const result = createAnnotationJsonExport(index, DEFAULT_ANNOTATION_PALETTE);
  const parsed = parseAnnotationExportV1(result.text);
  assert.equal(parsed.books[0].id, 'missing-book');
  assert.match(parsed.books[0].name, /알 수 없는 도서/);
  assert.throws(() => parseAnnotationExportV1(JSON.stringify({
    ...parsed,
    unexpected: true,
  })), /지원하지 않는/);
});

test('limits a book-scoped JSON export to the selected book', () => {
  const first = annotation('first', { bookId: 'book-1' });
  const second = annotation('second', { bookId: 'book-2' });
  const index = buildLibraryAnnotationIndex(
    [first, second],
    [{ id: 'book-1', name: '첫 책' }, { id: 'book-2', name: '둘째 책' }],
    DEFAULT_ANNOTATION_PALETTE,
  );
  const result = createAnnotationJsonExport(
    index,
    DEFAULT_ANNOTATION_PALETTE,
    { kind: 'book', bookId: 'book-2' },
    1_700_000_000_000,
  );
  const parsed = parseAnnotationExportV1(result.text);
  assert.deepEqual(parsed.annotations.map(({ id }) => id), ['second']);
  assert.deepEqual(parsed.books.map(({ id }) => id), ['book-2']);
  assert.throws(() => parseAnnotationExportV1(JSON.stringify({
    ...parsed,
    books: [...parsed.books, { id: 'book-1', name: '첫 책' }],
    annotations: [second, first],
  })), /지원하지 않는/);
  assert.throws(() => parseAnnotationExportV1(JSON.stringify({
    ...parsed,
    annotations: [second, second],
  })), /지원하지 않는/);
});
