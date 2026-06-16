export const LAST_READER_SESSION_KEY = 'last_reader_session';
export const LAST_READER_COMPLETE_PERCENT = 99.9;

export type LastReaderSession = {
  bookId: string;
  updatedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const getBrowserStorage = (): StorageLike | null => (
  typeof window === 'undefined' ? null : window.localStorage
);

export const isLastReaderProgressComplete = (progressPercent?: number | null) => (
  typeof progressPercent === 'number'
  && Number.isFinite(progressPercent)
  && progressPercent >= LAST_READER_COMPLETE_PERCENT
);

export const readLastReaderSession = (
  storage: StorageLike | null = getBrowserStorage(),
): LastReaderSession | null => {
  if (!storage) return null;

  try {
    const raw = storage.getItem(LAST_READER_SESSION_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<LastReaderSession>;
    if (typeof parsed.bookId !== 'string' || parsed.bookId.trim() === '') return null;
    return {
      bookId: parsed.bookId,
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : 0,
    };
  } catch {
    storage.removeItem(LAST_READER_SESSION_KEY);
    return null;
  }
};

export const clearLastReaderSession = (
  storage: StorageLike | null = getBrowserStorage(),
  bookId?: string,
) => {
  if (!storage) return;
  if (bookId) {
    const current = readLastReaderSession(storage);
    if (current?.bookId !== bookId) return;
  }
  storage.removeItem(LAST_READER_SESSION_KEY);
};

export const saveLastReaderSession = (
  bookId: string,
  progressPercent?: number | null,
  storage: StorageLike | null = getBrowserStorage(),
) => {
  if (!storage) return;
  if (!bookId || isLastReaderProgressComplete(progressPercent)) {
    clearLastReaderSession(storage, bookId);
    return;
  }

  storage.setItem(
    LAST_READER_SESSION_KEY,
    JSON.stringify({ bookId, updatedAt: Date.now() }),
  );
};

export const getLastReaderBookCandidate = <T extends { id: string }>(
  books: T[],
  storage: StorageLike | null = getBrowserStorage(),
): T | null => {
  const session = readLastReaderSession(storage);
  if (!session) return null;

  const book = books.find((item) => item.id === session.bookId);
  if (!book) {
    clearLastReaderSession(storage, session.bookId);
    return null;
  }

  return book;
};
