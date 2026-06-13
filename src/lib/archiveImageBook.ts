import type { FoliateBook } from '../hooks/foliate/types';

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_IMAGE_PAGES = 10_000;
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CACHED_PAGES = 4;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export type RawArchiveEntry<T> = {
  name: string;
  directory: boolean;
  encrypted: boolean;
  size: number;
  source: T;
};

export type ArchiveImageEntry<T = unknown> = {
  name: string;
  normalizedName: string;
  size: number;
  encrypted: boolean;
  mimeType: string;
  source: T;
};

export type ArchiveInspection<T = unknown> = {
  entries: ArchiveImageEntry<T>[];
  totalImageBytes: number;
};

export class ArchiveImageError extends Error {
  readonly code:
      | 'damaged'
      | 'encrypted'
      | 'no-images'
      | 'too-many-entries'
      | 'too-many-images'
      | 'image-too-large'
      | 'expanded-size-too-large';

  constructor(code: ArchiveImageError['code'], message: string) {
    super(message);
    this.name = 'ArchiveImageError';
    this.code = code;
  }
}

const normalizeArchivePath = (name: string) => (
  name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').normalize('NFC')
);

const getImageMimeType = (name: string) => {
  const extension = name.toLowerCase().match(/\.([^.\/]+)$/)?.[1];
  return extension ? IMAGE_MIME_BY_EXTENSION[extension] : undefined;
};

const isIgnoredArchivePath = (normalizedName: string) => {
  const segments = normalizedName.split('/').filter(Boolean);
  if (segments.length === 0) return true;
  if (segments.some((segment) => segment === '__MACOSX')) return true;

  const baseName = segments.at(-1) ?? '';
  return baseName === '.DS_Store' || baseName.startsWith('.');
};

const naturalPathCompare = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
}).compare;

export const selectArchiveImageEntries = <T>(
  entries: RawArchiveEntry<T>[],
): ArchiveInspection<T> => {
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new ArchiveImageError('too-many-entries', '압축 파일의 항목 수가 너무 많습니다.');
  }

  const imageEntries = entries.flatMap((entry): ArchiveImageEntry<T>[] => {
    if (entry.directory) return [];
    const normalizedName = normalizeArchivePath(entry.name);
    const mimeType = getImageMimeType(normalizedName);
    if (!mimeType || isIgnoredArchivePath(normalizedName)) return [];

    return [{
      name: entry.name,
      normalizedName,
      size: entry.size,
      encrypted: entry.encrypted,
      mimeType,
      source: entry.source,
    }];
  }).sort((left, right) => (
    naturalPathCompare(left.normalizedName, right.normalizedName)
    || left.normalizedName.localeCompare(right.normalizedName)
  ));

  if (imageEntries.length === 0) {
    throw new ArchiveImageError('no-images', '압축 파일에 지원하는 이미지가 없습니다.');
  }
  if (imageEntries.length > MAX_IMAGE_PAGES) {
    throw new ArchiveImageError('too-many-images', '압축 파일의 이미지 수가 너무 많습니다.');
  }
  if (imageEntries.some((entry) => entry.encrypted)) {
    throw new ArchiveImageError('encrypted', '비밀번호로 잠긴 압축 파일은 지원하지 않습니다.');
  }

  const oversizedEntry = imageEntries.find((entry) => entry.size > MAX_IMAGE_BYTES);
  if (oversizedEntry) {
    throw new ArchiveImageError(
      'image-too-large',
      `압축 파일의 이미지 한 장이 100MB 제한을 초과합니다: ${oversizedEntry.normalizedName}`,
    );
  }

  const totalImageBytes = imageEntries.reduce((total, entry) => total + entry.size, 0);
  if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new ArchiveImageError(
      'expanded-size-too-large',
      '압축 해제 후 예상 이미지 용량이 2GB 제한을 초과합니다.',
    );
  }

  return { entries: imageEntries, totalImageBytes };
};

type CachedPage = {
  imageUrl: string;
  pageUrl: string;
};

const createPageHtml = (imageUrl: string) => `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #111; overflow: hidden; }
    body { display: flex; align-items: center; justify-content: center; }
    img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
  </style>
</head>
<body><img src="${imageUrl}" alt=""></body>
</html>`;

export type ArchiveImageSource<T> = {
  entries: ArchiveImageEntry<T>[];
  loadBlob: (entry: ArchiveImageEntry<T>) => Promise<Blob>;
  close: () => void;
};

type CreateArchiveImageBookOptions<T> = ArchiveImageSource<T> & {
  fileName: string;
};

export const createArchiveImageBook = <T>({
  entries,
  fileName,
  loadBlob,
  close,
}: CreateArchiveImageBookOptions<T>): FoliateBook => {
  const cache = new Map<number, CachedPage>();
  const pendingPages = new Map<number, Promise<string>>();
  let destroyed = false;

  const revokePage = (index: number) => {
    const cached = cache.get(index);
    if (!cached) return;
    URL.revokeObjectURL(cached.imageUrl);
    URL.revokeObjectURL(cached.pageUrl);
    cache.delete(index);
  };

  const loadPage = async (index: number): Promise<string> => {
    if (destroyed) throw new Error('Archive image source is closed.');
    const cached = cache.get(index);
    if (cached) {
      cache.delete(index);
      cache.set(index, cached);
      return cached.pageUrl;
    }

    const pendingPage = pendingPages.get(index);
    if (pendingPage) return pendingPage;

    const loadPromise = (async () => {
      const entry = entries[index];
      try {
        const imageBlob = await loadBlob(entry);
        if (destroyed) throw new Error('Archive image source is closed.');

        const imageUrl = URL.createObjectURL(imageBlob);
        const pageUrl = URL.createObjectURL(new Blob(
          [createPageHtml(imageUrl)],
          { type: 'text/html' },
        ));
        cache.set(index, { imageUrl, pageUrl });

        while (cache.size > MAX_CACHED_PAGES) {
          const oldestIndex = cache.keys().next().value;
          if (typeof oldestIndex !== 'number') break;
          revokePage(oldestIndex);
        }

        return pageUrl;
      } catch (error) {
        if (destroyed || error instanceof ArchiveImageError) throw error;
        throw new ArchiveImageError(
          'damaged',
          `이미지 페이지를 압축 해제하지 못했습니다: ${entry.normalizedName}`,
        );
      }
    })().finally(() => {
      pendingPages.delete(index);
    });

    pendingPages.set(index, loadPromise);
    return loadPromise;
  };

  const sections = entries.map((entry, index) => ({
    id: entry.normalizedName,
    href: entry.normalizedName,
    size: entry.size,
    load: () => loadPage(index),
  }));

  return {
    sections,
    toc: entries.map((entry) => ({
      label: entry.normalizedName.split('/').at(-1) ?? entry.normalizedName,
      href: entry.normalizedName,
    })),
    metadata: { title: fileName },
    rendition: { layout: 'pre-paginated', spread: 'none' },
    resolveHref: (href: string) => ({
      index: sections.findIndex((section) => section.id === href),
    }),
    splitTOCHref: (href: string) => [href, null],
    getTOCFragment: (doc: Document) => doc.documentElement,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      [...cache.keys()].forEach(revokePage);
      close();
    },
  };
};
