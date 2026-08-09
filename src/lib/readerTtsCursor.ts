export const READER_TTS_CURSOR_STORAGE_KEY = 'reader_tts_cursor_v1';
export const READER_TTS_CURSOR_LIMIT = 100;

export type ReaderTtsCursor = {
  ownerKey: string;
  bookId: string;
  sectionIndex: number;
  sourceIndex: number;
  cfi: string;
  text: string;
  contentIdentity?: string;
  updatedAt: number;
};

export const getReaderTtsContentIdentity = ({
  md5Checksum,
  modifiedTime,
  size,
}: {
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string | number;
}) => {
  if (md5Checksum) return `md5:${md5Checksum}`;
  if (modifiedTime) return `modified:${modifiedTime}|size:${size ?? ''}`;
  return '';
};

const cursorIdentity = (ownerKey: string, bookId: string) => (
  JSON.stringify([ownerKey, bookId])
);

const normalizeCursor = (value: unknown): ReaderTtsCursor | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ReaderTtsCursor>;
  if (
    typeof candidate.ownerKey !== 'string'
    || !candidate.ownerKey
    || candidate.ownerKey.length > 1_000
    || typeof candidate.bookId !== 'string'
    || !candidate.bookId
    || candidate.bookId.length > 1_000
    || !Number.isSafeInteger(candidate.sectionIndex)
    || Number(candidate.sectionIndex) < 0
    || !Number.isSafeInteger(candidate.sourceIndex)
    || Number(candidate.sourceIndex) < 0
    || typeof candidate.cfi !== 'string'
    || !candidate.cfi
    || candidate.cfi.length > 10_000
    || typeof candidate.text !== 'string'
    || candidate.text.length > 1_000
    || (candidate.contentIdentity !== undefined && (
      typeof candidate.contentIdentity !== 'string'
      || candidate.contentIdentity.length > 2_000
    ))
    || !Number.isSafeInteger(candidate.updatedAt)
    || Number(candidate.updatedAt) <= 0
  ) return null;
  return candidate as ReaderTtsCursor;
};

const readCursorList = (storage: Pick<Storage, 'getItem'>): ReaderTtsCursor[] => {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(READER_TTS_CURSOR_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const byIdentity = new Map<string, ReaderTtsCursor>();
    for (const value of parsed) {
      const cursor = normalizeCursor(value);
      if (!cursor) continue;
      const identity = cursorIdentity(cursor.ownerKey, cursor.bookId);
      const existing = byIdentity.get(identity);
      if (!existing || existing.updatedAt < cursor.updatedAt) byIdentity.set(identity, cursor);
    }
    return [...byIdentity.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, READER_TTS_CURSOR_LIMIT);
  } catch {
    return [];
  }
};

const defaultStorage = () => (
  typeof window === 'undefined' ? null : window.localStorage
);

export const readReaderTtsCursor = (
  ownerKey: string,
  bookId: string,
  storage = defaultStorage(),
  contentIdentity = '',
) => {
  if (!storage) return null;
  const identity = cursorIdentity(ownerKey, bookId);
  const cursors = readCursorList(storage);
  const cursor = cursors.find((item) => (
    cursorIdentity(item.ownerKey, item.bookId) === identity
  )) ?? null;
  if (cursor && contentIdentity && cursor.contentIdentity !== contentIdentity) {
    try {
      storage.setItem(
        READER_TTS_CURSOR_STORAGE_KEY,
        JSON.stringify(cursors.filter((item) => (
          cursorIdentity(item.ownerKey, item.bookId) !== identity
        ))),
      );
    } catch {
      // A stale cursor is still rejected even if storage cleanup is unavailable.
    }
    return null;
  }
  return cursor;
};

export const saveReaderTtsCursor = (
  cursor: ReaderTtsCursor,
  storage = defaultStorage(),
) => {
  if (!storage) return false;
  const normalized = normalizeCursor(cursor);
  if (!normalized) return false;
  const identity = cursorIdentity(normalized.ownerKey, normalized.bookId);
  const next = readCursorList(storage)
    .filter((item) => cursorIdentity(item.ownerKey, item.bookId) !== identity);
  next.unshift(normalized);
  try {
    storage.setItem(
      READER_TTS_CURSOR_STORAGE_KEY,
      JSON.stringify(next.slice(0, READER_TTS_CURSOR_LIMIT)),
    );
    return true;
  } catch {
    return false;
  }
};

export const clearReaderTtsCursor = (
  ownerKey: string,
  bookId: string,
  storage = defaultStorage(),
) => {
  if (!storage) return false;
  const identity = cursorIdentity(ownerKey, bookId);
  const current = readCursorList(storage);
  const next = current.filter((item) => cursorIdentity(item.ownerKey, item.bookId) !== identity);
  if (next.length === current.length) return false;
  try {
    storage.setItem(READER_TTS_CURSOR_STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
};
