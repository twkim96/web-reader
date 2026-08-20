import type { Entry, FileEntry } from '@zip.js/zip.js';
import {
  ArchiveImageError,
  createArchiveImageIndex,
  createArchiveImageBook,
  loadArchiveImageBlob,
  restoreArchiveImageInspection,
  selectArchiveImageEntries,
  type ArchiveImageIndex,
} from './archiveImageBook.ts';
import { BOOK_COVER_MAX_SOURCE_BYTES } from './bookCoverPolicy.ts';

type ZipModule = typeof import('@zip.js/zip.js');
type BrowserNavigator = Pick<Navigator, 'maxTouchPoints' | 'platform' | 'userAgent'>;

export { ArchiveImageError, selectArchiveImageEntries } from './archiveImageBook.ts';

let zipModulePromise: Promise<ZipModule> | null = null;

const getBrowserNavigator = (): BrowserNavigator | undefined => (
  typeof navigator === 'undefined' ? undefined : navigator
);

export const shouldUseZipWebWorkers = (
  workerAvailable = typeof Worker !== 'undefined',
  browserNavigator: BrowserNavigator | undefined = getBrowserNavigator(),
) => {
  if (!workerAvailable) return false;

  const userAgent = browserNavigator?.userAgent ?? '';
  const platform = browserNavigator?.platform ?? '';
  const isAppleMobile = /iPad|iPhone|iPod/.test(userAgent)
    || (platform === 'MacIntel' && (browserNavigator?.maxTouchPoints ?? 0) > 1);

  // iPad browsers all use WebKit. zip.js worker/stream transfers can stall there,
  // so use zip.js's same-thread fallback for a reliable first-page extraction.
  return !isAppleMobile;
};

const loadZipModule = async () => {
  if (!zipModulePromise) {
    zipModulePromise = import('@zip.js/zip.js').then((zip) => {
      zip.configure({
        useWebWorkers: shouldUseZipWebWorkers(),
        workerURI: '/zip/zip-web-worker.js',
        wasmURI: '/zip/zip-module.wasm',
      });
      return zip;
    });
  }
  return zipModulePromise;
};

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === 'AbortError'
);

const openArchive = async (
  blob: Blob,
  cachedIndex?: ArchiveImageIndex,
  signal?: AbortSignal,
) => {
  const { BlobReader, ZipReader } = await loadZipModule();
  if (signal?.aborted) throw new DOMException('Archive preparation aborted', 'AbortError');
  const reader = new ZipReader(new BlobReader(blob), { signal });

  try {
    const entries = await reader.getEntries();
    if (signal?.aborted) {
      throw new DOMException('Archive preparation aborted', 'AbortError');
    }
    const rawEntries = entries.map((entry: Entry) => ({
      name: entry.filename,
      directory: entry.directory,
      encrypted: entry.encrypted,
      size: entry.uncompressedSize,
      source: entry as FileEntry,
    }));
    const inspection = cachedIndex
      ? restoreArchiveImageInspection(rawEntries, cachedIndex)
      : selectArchiveImageEntries(rawEntries);
    return { reader, inspection };
  } catch (error) {
    await reader.close().catch(() => undefined);
    if (isAbortError(error)) throw error;
    if (error instanceof ArchiveImageError) throw error;
    throw new ArchiveImageError('damaged', '압축 파일이 손상되었거나 지원하지 않는 방식입니다.');
  }
};

export const inspectZipImageArchive = async (
  blob: Blob,
  options: { includeCoverSource?: boolean; signal?: AbortSignal } = {},
) => {
  const [{ BlobWriter }, { reader, inspection }] = await Promise.all([
    loadZipModule(),
    openArchive(blob, undefined, options.signal),
  ]);
  let coverSource: Blob | undefined;
  try {
    const firstEntry = inspection.entries[0];
    if (
      options.includeCoverSource
      && firstEntry
      && firstEntry.size <= BOOK_COVER_MAX_SOURCE_BYTES
    ) {
      try {
        coverSource = await loadArchiveImageBlob(
          firstEntry,
          (entry, signal) => entry.source.getData(
            new BlobWriter(entry.mimeType),
            { signal },
          ),
          options.signal,
        );
      } catch (error) {
        if (isAbortError(error)) throw error;
        // Cover extraction is best-effort and must not reject a valid archive import.
      }
    }
    return {
      imageCount: inspection.entries.length,
      totalImageBytes: inspection.totalImageBytes,
      names: inspection.entries.map((entry) => entry.normalizedName),
      index: createArchiveImageIndex(inspection),
      coverSource,
    };
  } finally {
    await reader.close().catch(() => undefined);
  }
};

export const prepareZipImageBook = async (
  blob: Blob,
  fileName: string,
  cachedIndex?: ArchiveImageIndex,
  signal?: AbortSignal,
) => {
  const [{ BlobWriter }, { reader, inspection }] = await Promise.all([
    loadZipModule(),
    openArchive(blob, cachedIndex, signal),
  ]);
  return {
    book: createArchiveImageBook({
      entries: inspection.entries,
      fileName,
      loadBlob: (entry, signal) => entry.source.getData(
        new BlobWriter(entry.mimeType),
        { signal },
      ),
      close: () => {
        void reader.close();
      },
    }),
    index: createArchiveImageIndex(inspection),
  };
};

export const createZipImageBook = async (blob: Blob, fileName: string) => (
  prepareZipImageBook(blob, fileName).then(({ book }) => book)
);
