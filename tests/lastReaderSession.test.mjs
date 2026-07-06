import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAST_READER_SESSION_KEY,
  LAST_READER_SESSION_VERSION,
  clearLastReaderSession,
  getLastReaderBookCandidate,
  readLastReaderSession,
  saveLastReaderSession,
} from '../src/lib/lastReaderSession.ts';

const createStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

test('stores and reads the last reader book locally', () => {
  const storage = createStorage();

  saveLastReaderSession('book-1', 42, storage);
  const session = readLastReaderSession(storage);

  assert.equal(session.bookId, 'book-1');
  assert.equal(session.version, LAST_READER_SESSION_VERSION);
  assert.equal(typeof session.updatedAt, 'number');
});

test('clears legacy sessions without using them as auto-open intent', () => {
  const storage = createStorage();
  storage.setItem(LAST_READER_SESSION_KEY, JSON.stringify({
    bookId: 'book-1',
    updatedAt: Date.now(),
  }));

  assert.equal(readLastReaderSession(storage), null);
  assert.equal(storage.getItem(LAST_READER_SESSION_KEY), null);
});

test('clears malformed sessions without keeping stale intent', () => {
  const storage = createStorage();
  storage.setItem(LAST_READER_SESSION_KEY, JSON.stringify({
    version: LAST_READER_SESSION_VERSION,
    bookId: ' ',
    updatedAt: Date.now(),
  }));

  assert.equal(readLastReaderSession(storage), null);
  assert.equal(storage.getItem(LAST_READER_SESSION_KEY), null);
});

test('does not keep a completed book as the last reader session', () => {
  const storage = createStorage();

  saveLastReaderSession('book-1', 42, storage);
  saveLastReaderSession('book-1', 99.9, storage);

  assert.equal(readLastReaderSession(storage), null);
});

test('clears only the matching last reader book', () => {
  const storage = createStorage();

  saveLastReaderSession('book-1', 10, storage);
  clearLastReaderSession(storage, 'book-2');
  assert.equal(readLastReaderSession(storage).bookId, 'book-1');

  clearLastReaderSession(storage, 'book-1');
  assert.equal(readLastReaderSession(storage), null);
});

test('returns a candidate from restored books and clears invalid sessions', () => {
  const storage = createStorage();
  const books = [{ id: 'book-1' }, { id: 'book-2' }];

  saveLastReaderSession('book-2', 50, storage);
  assert.deepEqual(getLastReaderBookCandidate(books, storage), { id: 'book-2' });

  saveLastReaderSession('book-3', 50, storage);
  assert.equal(getLastReaderBookCandidate(books, storage), null);
  assert.equal(storage.getItem(LAST_READER_SESSION_KEY), null);
});
