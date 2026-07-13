import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('runtime reads only the Firebase account canonical history', async () => {
  const libraryData = await readFile(new URL('../src/hooks/useLibraryData.ts', import.meta.url), 'utf8');
  const progressSync = await readFile(new URL('../src/hooks/useProgressSync.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(libraryData, /readingHistory|RemoteProgressDoc|getDocs\(/);
  assert.doesNotMatch(progressSync, /users.*readingHistory|LegacyV1|legacyV1Bridge/);
  assert.match(progressSync, /getFirebaseSyncHistoryPath/);
});
