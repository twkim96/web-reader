import type { PreparedBookSource } from './bookContent';
import type { FoliateBook } from '../hooks/foliate/types';

export const createAbortError = () => new DOMException('Reader load aborted', 'AbortError');

export const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === 'AbortError'
);

export const throwIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw createAbortError();
};

export const destroyPreparedBookSource = (prepared: PreparedBookSource | null | undefined) => {
  if (!prepared || prepared.format !== 'archive') return;
  try {
    (prepared.source as FoliateBook).destroy?.();
  } catch {
    // Cleanup must not replace the original load or cancellation error.
  }
};

type RunReaderBookOpenOptions = {
  signal: AbortSignal;
  prepare: () => Promise<PreparedBookSource>;
  open: (prepared: PreparedBookSource) => Promise<void>;
  commit: (prepared: PreparedBookSource) => void;
};

export const runReaderBookOpen = async ({
  signal,
  prepare,
  open,
  commit,
}: RunReaderBookOpenOptions) => {
  let prepared: PreparedBookSource | null = null;
  let released = false;
  const destroyOwnedSource = () => {
    if (released) return;
    destroyPreparedBookSource(prepared);
    prepared = null;
  };

  signal.addEventListener('abort', destroyOwnedSource);
  try {
    throwIfAborted(signal);
    prepared = await prepare();
    throwIfAborted(signal);
    await open(prepared);
    throwIfAborted(signal);
    commit(prepared);
    released = true;
    return prepared;
  } catch (error) {
    destroyOwnedSource();
    throw error;
  } finally {
    signal.removeEventListener('abort', destroyOwnedSource);
  }
};
