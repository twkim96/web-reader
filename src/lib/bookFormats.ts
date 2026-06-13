export type SourceBookFormat = 'txt' | 'epub' | 'pdf' | 'zip' | 'cbz' | '7z';
export type ReaderFormat = 'epub' | 'pdf' | 'archive';
export type ArchiveFormat = 'zip' | 'cbz' | '7z';

type ImportFileLike = {
  name: string;
  size: number;
  type?: string;
};

type ImportSelectionOptions = {
  allowExtendedFormats?: boolean;
  enabledFormats?: ReadonlySet<SourceBookFormat>;
  maxFiles?: number;
};

export type ImportSelectionResult<T extends ImportFileLike> = {
  files: T[];
  error: string | null;
};

const BYTES_PER_MB = 1024 * 1024;

export const GENERAL_FILE_MAX_BYTES = 150 * BYTES_PER_MB;
export const GENERAL_TOTAL_MAX_BYTES = 500 * BYTES_PER_MB;
export const ARCHIVE_FILE_MAX_BYTES = 300 * BYTES_PER_MB;
export const DEFAULT_MAX_IMPORT_FILES = 10;

export const EPUB_MIME = 'application/epub+zip';
export const TXT_MIME = 'text/plain';
export const PDF_MIME = 'application/pdf';
export const ZIP_MIME = 'application/zip';
export const CBZ_MIME = 'application/vnd.comicbook+zip';
export const SEVEN_Z_MIME = 'application/x-7z-compressed';

const EXTENSION_FORMATS: ReadonlyArray<[string, SourceBookFormat]> = [
  ['.txt', 'txt'],
  ['.epub', 'epub'],
  ['.pdf', 'pdf'],
  ['.cbz', 'cbz'],
  ['.zip', 'zip'],
  ['.7z', '7z'],
];

const MIME_FORMATS: Record<string, SourceBookFormat> = {
  [EPUB_MIME]: 'epub',
  [TXT_MIME]: 'txt',
  [PDF_MIME]: 'pdf',
  [ZIP_MIME]: 'zip',
  'application/x-zip-compressed': 'zip',
  [CBZ_MIME]: 'cbz',
  [SEVEN_Z_MIME]: '7z',
};

const MIME_BY_FORMAT: Record<SourceBookFormat, string> = {
  txt: TXT_MIME,
  epub: EPUB_MIME,
  pdf: PDF_MIME,
  zip: ZIP_MIME,
  cbz: CBZ_MIME,
  '7z': SEVEN_Z_MIME,
};

const BASE_FORMATS = new Set<SourceBookFormat>(['txt', 'epub']);
const ALL_FORMATS = new Set<SourceBookFormat>(EXTENSION_FORMATS.map(([, format]) => format));
export const ACTIVE_SOURCE_FORMATS = new Set<SourceBookFormat>([
  'txt',
  'epub',
  'pdf',
  'zip',
  'cbz',
  '7z',
]);

export const ALL_IMPORT_ACCEPT = EXTENSION_FORMATS.map(([extension]) => extension).join(',');
export const BASE_IMPORT_ACCEPT = '.txt,.epub';
export const EXTENDED_IMPORT_FORMATS_ENABLED = ACTIVE_SOURCE_FORMATS.size > BASE_FORMATS.size;
export const ACTIVE_IMPORT_ACCEPT = EXTENSION_FORMATS
  .filter(([, format]) => ACTIVE_SOURCE_FORMATS.has(format))
  .map(([extension]) => extension)
  .join(',');

export const getSourceBookFormat = (fileName: string, mimeType = ''): SourceBookFormat | null => {
  const lowerName = fileName.toLowerCase();
  const extensionMatch = EXTENSION_FORMATS.find(([extension]) => lowerName.endsWith(extension));
  if (extensionMatch) return extensionMatch[1];
  return MIME_FORMATS[mimeType.toLowerCase()] ?? null;
};

export const getReaderFormat = (format: SourceBookFormat): ReaderFormat => {
  if (format === 'pdf') return 'pdf';
  if (format === 'zip' || format === 'cbz' || format === '7z') return 'archive';
  return 'epub';
};

export const getArchiveFormat = (format: SourceBookFormat): ArchiveFormat | undefined => (
  format === 'zip' || format === 'cbz' || format === '7z' ? format : undefined
);

export const getBookMaxBytes = (format: SourceBookFormat) => (
  isArchiveFormat(format) ? ARCHIVE_FILE_MAX_BYTES : GENERAL_FILE_MAX_BYTES
);

export const getBookSizeBytes = (size: string | number | undefined) => {
  if (typeof size === 'number') return Number.isFinite(size) ? size : null;
  if (!size) return null;
  const parsed = Number(size);
  return Number.isFinite(parsed) ? parsed : null;
};

export const getBookOpenLimitError = (
  fileName: string,
  mimeType: string,
  size: string | number | undefined,
) => {
  const format = getSourceBookFormat(fileName, mimeType);
  const sizeBytes = getBookSizeBytes(size);
  if (!format || sizeBytes === null || sizeBytes <= getBookMaxBytes(format)) return null;
  return isArchiveFormat(format)
    ? '이 압축 도서는 300MB 제한을 초과하여 다운로드할 수 없습니다.'
    : '이 도서는 150MB 제한을 초과하여 다운로드할 수 없습니다.';
};

export const isArchiveFormat = (format: SourceBookFormat | null): format is ArchiveFormat => (
  format === 'zip' || format === 'cbz' || format === '7z'
);

export const getSupportedBookMimeType = (fileName: string, fallbackMimeType = '') => {
  const format = getSourceBookFormat(fileName, fallbackMimeType);
  return format ? MIME_BY_FORMAT[format] : fallbackMimeType;
};

export const getBookTitleFromFileName = (fileName: string) => (
  fileName.normalize('NFC').replace(/\.(?:epub|txt|pdf|zip|cbz|7z)$/i, '')
);

const formatFileSize = (bytes: number) => `${(bytes / BYTES_PER_MB).toFixed(2)}MB`;

export const updateImportSelection = <T extends ImportFileLike>(
  selectedFiles: T[],
  incomingFiles: T[],
  options: ImportSelectionOptions = {},
): ImportSelectionResult<T> => {
  if (incomingFiles.length === 0) return { files: selectedFiles, error: null };

  const allowExtendedFormats = options.allowExtendedFormats ?? EXTENDED_IMPORT_FORMATS_ENABLED;
  const enabledFormats = options.enabledFormats ?? (allowExtendedFormats ? ALL_FORMATS : BASE_FORMATS);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_IMPORT_FILES;
  const incomingFormats = incomingFiles.map((file) => getSourceBookFormat(file.name, file.type));

  if (incomingFormats.some((format) => !format || !enabledFormats.has(format))) {
    const supported = EXTENSION_FORMATS
      .filter(([, format]) => enabledFormats.has(format))
      .map(([extension]) => extension)
      .join(', ');
    return {
      files: selectedFiles,
      error: `지원하는 도서 파일(${supported})을 선택해 주세요.`,
    };
  }

  const selectedFormats = selectedFiles.map((file) => getSourceBookFormat(file.name, file.type));
  const selectedHasArchive = selectedFormats.some(isArchiveFormat);
  const incomingArchives = incomingFormats.filter(isArchiveFormat);

  if (selectedHasArchive) {
    return {
      files: selectedFiles,
      error: '압축 도서는 다른 파일과 함께 추가할 수 없습니다.',
    };
  }

  if (incomingArchives.length > 0) {
    if (selectedFiles.length > 0) {
      return {
        files: selectedFiles,
        error: '압축 도서는 단독으로 추가해야 합니다. 기존 선택을 비운 뒤 다시 선택해 주세요.',
      };
    }

    if (incomingFiles.length !== 1 || incomingArchives.length !== 1) {
      return {
        files: selectedFiles,
        error: '압축 도서는 한 번에 하나만 선택해 주세요.',
      };
    }

    const archiveFile = incomingFiles[0];
    if (archiveFile.size > ARCHIVE_FILE_MAX_BYTES) {
      return {
        files: selectedFiles,
        error: `압축 도서의 최대 용량은 300MB입니다.\n${archiveFile.name}: ${formatFileSize(archiveFile.size)}`,
      };
    }

    return { files: [archiveFile], error: null };
  }

  const nextFiles = [...selectedFiles, ...incomingFiles];
  if (nextFiles.length > maxFiles) {
    return {
      files: selectedFiles,
      error: `도서는 한 번에 최대 ${maxFiles}개까지 추가할 수 있습니다.`,
    };
  }

  const oversizedFile = incomingFiles.find((file) => file.size > GENERAL_FILE_MAX_BYTES);
  if (oversizedFile) {
    return {
      files: selectedFiles,
      error: `일반 도서 하나의 최대 용량은 150MB입니다.\n${oversizedFile.name}: ${formatFileSize(oversizedFile.size)}`,
    };
  }

  const totalBytes = nextFiles.reduce((total, file) => total + file.size, 0);
  if (totalBytes > GENERAL_TOTAL_MAX_BYTES) {
    return {
      files: selectedFiles,
      error: '한 번에 추가할 일반 도서의 총 용량은 500MB까지입니다.',
    };
  }

  return { files: nextFiles, error: null };
};
