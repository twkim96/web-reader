import JSZip from 'jszip';
import { EPUB_MIME } from './bookFormats.ts';

const hasZipSignature = (buffer: ArrayBuffer) => {
  const view = new Uint8Array(buffer);
  return view.length >= 4
    && view[0] === 0x50
    && view[1] === 0x4B
    && view[2] === 0x03
    && view[3] === 0x04;
};

export const isEpubBuffer = async (buffer: ArrayBuffer) => {
  if (!hasZipSignature(buffer)) return false;

  try {
    const zip = await JSZip.loadAsync(buffer);
    const mimetype = zip.file('mimetype');
    const container = zip.file('META-INF/container.xml');
    if (!mimetype || !container) return false;
    return (await mimetype.async('string')).trim() === EPUB_MIME;
  } catch {
    return false;
  }
};
