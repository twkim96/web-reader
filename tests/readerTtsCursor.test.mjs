import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearReaderTtsCursor,
  getReaderTtsContentIdentity,
  readReaderTtsCursor,
  READER_TTS_CURSOR_LIMIT,
  READER_TTS_CURSOR_STORAGE_KEY,
  saveReaderTtsCursor,
} from '../src/lib/readerTtsCursor.ts';

const createStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
};

const cursor = (overrides = {}) => ({
  ownerKey: 'guest:a',
  bookId: 'book-a',
  sectionIndex: 3,
  sourceIndex: 17,
  cfi: 'epubcfi(/6/8!/4/2:1)',
  text: '이어 읽을 문장',
  updatedAt: 100,
  ...overrides,
});

test('isolates TTS cursors by owner and book and replaces only the same identity', () => {
  const storage = createStorage();
  assert.equal(saveReaderTtsCursor(cursor(), storage), true);
  assert.equal(saveReaderTtsCursor(cursor({ ownerKey: 'guest:b' }), storage), true);
  assert.equal(saveReaderTtsCursor(cursor({ sourceIndex: 18, updatedAt: 200 }), storage), true);
  assert.equal(readReaderTtsCursor('guest:a', 'book-a', storage)?.sourceIndex, 18);
  assert.equal(readReaderTtsCursor('guest:b', 'book-a', storage)?.sourceIndex, 17);
  assert.equal(readReaderTtsCursor('guest:a', 'missing', storage), null);
});

test('drops malformed cursors and caps the local cursor list', () => {
  const storage = createStorage({
    [READER_TTS_CURSOR_STORAGE_KEY]: JSON.stringify([
      { nope: true },
      cursor({ updatedAt: -1 }),
    ]),
  });
  assert.equal(readReaderTtsCursor('guest:a', 'book-a', storage), null);
  for (let index = 0; index < READER_TTS_CURSOR_LIMIT + 5; index += 1) {
    assert.equal(saveReaderTtsCursor(cursor({
      bookId: `book-${index}`,
      updatedAt: index + 1,
    }), storage), true);
  }
  const stored = JSON.parse(storage.getItem(READER_TTS_CURSOR_STORAGE_KEY));
  assert.equal(stored.length, READER_TTS_CURSOR_LIMIT);
  assert.equal(stored[0].bookId, `book-${READER_TTS_CURSOR_LIMIT + 4}`);
});

test('clears only the requested TTS cursor', () => {
  const storage = createStorage();
  saveReaderTtsCursor(cursor(), storage);
  saveReaderTtsCursor(cursor({ bookId: 'book-b' }), storage);
  assert.equal(clearReaderTtsCursor('guest:a', 'book-a', storage), true);
  assert.equal(readReaderTtsCursor('guest:a', 'book-a', storage), null);
  assert.equal(readReaderTtsCursor('guest:a', 'book-b', storage)?.bookId, 'book-b');
  assert.equal(clearReaderTtsCursor('guest:a', 'book-a', storage), false);
});

test('rejects and removes a cursor when the current book content identity changed', () => {
  const storage = createStorage();
  saveReaderTtsCursor(cursor({ contentIdentity: 'md5:old' }), storage);
  assert.equal(
    readReaderTtsCursor('guest:a', 'book-a', storage, 'md5:new'),
    null,
  );
  assert.equal(readReaderTtsCursor('guest:a', 'book-a', storage), null);
  assert.equal(getReaderTtsContentIdentity({ md5Checksum: 'abc' }), 'md5:abc');
  assert.equal(getReaderTtsContentIdentity({
    modifiedTime: '2026-08-09T00:00:00Z',
    size: 123,
  }), 'modified:2026-08-09T00:00:00Z|size:123');
});
