import { Book } from '../types';
import { convertTxtToEpub } from './txtToEpub';

const EPUB_MIME = 'application/epub+zip';
const TXT_MIME = 'text/plain';

export const getSupportedBookMimeType = (fileName: string, fallbackMimeType = '') => {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.epub')) return EPUB_MIME;
  if (lowerName.endsWith('.txt')) return TXT_MIME;
  return fallbackMimeType;
};

export const isEpubBuffer = (buffer: ArrayBuffer) => {
  const view = new Uint8Array(buffer);
  return view[0] === 0x50 && view[1] === 0x4B;
};

export const ensureEpubBook = async (book: Book, content: ArrayBuffer) => {
  if (isEpubBuffer(content)) {
    return {
      book: {
        ...book,
        name: book.name.replace(/\.txt$/i, '.epub'),
        mimeType: EPUB_MIME,
      },
      content,
    };
  }

  const isTxt = book.name.toLowerCase().endsWith('.txt') || book.mimeType === TXT_MIME;
  if (!isTxt) {
    throw new Error('지원하지 않는 도서 형식입니다.');
  }

  const epubBlob = await convertTxtToEpub(content, book.name, 'auto');
  return {
    book: {
      ...book,
      name: book.name.replace(/\.txt$/i, '.epub'),
      mimeType: EPUB_MIME,
    },
    content: await epubBlob.arrayBuffer(),
  };
};
