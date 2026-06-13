import type { Book } from '../types';
import { convertTxtToEpub } from './txtToEpub';
import {
  EPUB_MIME,
  getSourceBookFormat,
  TXT_MIME,
} from './bookFormats';
import { isEpubBuffer } from './epubValidation';

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
