import type { Entry, FileEntry } from '@zip.js/zip.js';
import {
  ArchiveImageError,
  createArchiveImageBook,
  selectArchiveImageEntries,
} from './archiveImageBook.ts';

type ZipModule = typeof import('@zip.js/zip.js');

export { ArchiveImageError, selectArchiveImageEntries } from './archiveImageBook.ts';

let zipModulePromise: Promise<ZipModule> | null = null;

const loadZipModule = async () => {
  if (!zipModulePromise) {
    zipModulePromise = import('@zip.js/zip.js').then((zip) => {
      zip.configure({
        useWebWorkers: typeof Worker !== 'undefined',
        workerURI: '/zip/zip-web-worker.js',
        wasmURI: '/zip/zip-module.wasm',
      });
      return zip;
    });
  }
  return zipModulePromise;
};

const openArchive = async (blob: Blob) => {
  const { BlobReader, ZipReader } = await loadZipModule();
  const reader = new ZipReader(new BlobReader(blob));

  try {
    const entries = await reader.getEntries();
    const inspection = selectArchiveImageEntries(entries.map((entry: Entry) => ({
      name: entry.filename,
      directory: entry.directory,
      encrypted: entry.encrypted,
      size: entry.uncompressedSize,
      source: entry as FileEntry,
    })));
    return { reader, inspection };
  } catch (error) {
    await reader.close().catch(() => undefined);
    if (error instanceof ArchiveImageError) throw error;
    throw new ArchiveImageError('damaged', '압축 파일이 손상되었거나 지원하지 않는 방식입니다.');
  }
};

export const inspectZipImageArchive = async (blob: Blob) => {
  const { reader, inspection } = await openArchive(blob);
  await reader.close();
  return {
    imageCount: inspection.entries.length,
    totalImageBytes: inspection.totalImageBytes,
    names: inspection.entries.map((entry) => entry.normalizedName),
  };
};

export const createZipImageBook = async (blob: Blob, fileName: string) => {
  const [{ BlobWriter }, { reader, inspection }] = await Promise.all([
    loadZipModule(),
    openArchive(blob),
  ]);
  return createArchiveImageBook({
    entries: inspection.entries,
    fileName,
    loadBlob: (entry) => entry.source.getData(new BlobWriter(entry.mimeType)),
    close: () => {
      void reader.close();
    },
  });
};
