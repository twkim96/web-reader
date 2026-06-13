import type { Book } from '../types';
import { convertTxtToEpub } from './txtToEpub';
import {
  EPUB_MIME,
  getSourceBookFormat,
  TXT_MIME,
} from './bookFormats';
import { isEpubBuffer } from './epubValidation';
import type { FoliateBook } from '../hooks/foliate/types';
import type { ReaderFormat } from './bookFormats';
import type { ArchiveImageIndex } from './archiveImageBook';

export { isEpubBuffer } from './epubValidation';

export const ensureEpubBook = async (book: Book, content: ArrayBuffer) => {
  if (await isEpubBuffer(content)) {
    const sourceFormat = book.sourceFormat ?? getSourceBookFormat(book.name, book.mimeType) ?? 'epub';
    return {
      book: {
        ...book,
        name: book.name.replace(/\.txt$/i, '.epub'),
        mimeType: EPUB_MIME,
        sourceFormat,
        readerFormat: 'epub' as const,
      },
      content,
    };
  }

  const sourceFormat = getSourceBookFormat(book.name, book.mimeType);
  const isTxt = sourceFormat === 'txt' || book.mimeType === TXT_MIME;
  if (!isTxt) {
    if (sourceFormat === 'epub') {
      throw new Error('올바른 EPUB 구조가 아닙니다.');
    }
    throw new Error('지원하지 않는 도서 형식입니다.');
  }

  const epubBlob = await convertTxtToEpub(content, book.name, 'auto');
  return {
    book: {
      ...book,
      name: book.name.replace(/\.txt$/i, '.epub'),
      mimeType: EPUB_MIME,
      sourceFormat: 'txt' as const,
      readerFormat: 'epub' as const,
    },
    content: await epubBlob.arrayBuffer(),
  };
};

export type StoredBookContent = ArrayBuffer | Blob;

export type PreparedBookSource = {
  book: Book;
  format: ReaderFormat;
  source: Blob | FoliateBook;
  cacheContent: StoredBookContent;
  archiveImageIndex?: ArchiveImageIndex;
};

type PrepareBookSourceOptions = {
  archiveImageIndex?: ArchiveImageIndex;
};

const toBlob = (content: StoredBookContent, mimeType: string) => (
  content instanceof Blob ? content : new Blob([content], { type: mimeType })
);

export const prepareBookSource = async (
  book: Book,
  content: StoredBookContent,
  options: PrepareBookSourceOptions = {},
): Promise<PreparedBookSource> => {
  const sourceFormat = book.sourceFormat ?? getSourceBookFormat(book.name, book.mimeType);

  if (sourceFormat === 'pdf') {
    const sourceBlob = toBlob(content, book.mimeType);
    return {
      book: {
        ...book,
        sourceFormat,
        readerFormat: 'pdf',
      },
      format: 'pdf',
      source: sourceBlob,
      cacheContent: sourceBlob,
    };
  }

  if (sourceFormat === 'zip' || sourceFormat === 'cbz' || sourceFormat === '7z') {
    const sourceBlob = toBlob(content, book.mimeType);
    const prepared = sourceFormat === '7z'
      ? await import('./sevenZipImages').then(({ prepareSevenZipImageBook }) => (
        prepareSevenZipImageBook(sourceBlob, book.name, options.archiveImageIndex)
      ))
      : await import('./archiveImages').then(({ prepareZipImageBook }) => (
        prepareZipImageBook(sourceBlob, book.name, options.archiveImageIndex)
      ));
    return {
      book: {
        ...book,
        sourceFormat,
        readerFormat: 'archive',
        archiveFormat: sourceFormat,
      },
      format: 'archive',
      source: prepared.book,
      cacheContent: sourceBlob,
      archiveImageIndex: prepared.index,
    };
  }

  const buffer = content instanceof Blob ? await content.arrayBuffer() : content;
  const epub = await ensureEpubBook(book, buffer);
  return {
    book: epub.book,
    format: 'epub',
    source: new Blob([epub.content], { type: EPUB_MIME }),
    cacheContent: epub.content,
  };
};
