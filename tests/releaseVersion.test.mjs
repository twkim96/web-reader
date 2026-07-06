import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXPECTED_VERSION = '1.6.5.4';

test('keeps package metadata and service worker cache on the release version', async () => {
  const [packageText, lockText, serviceWorker] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const packageLock = JSON.parse(lockText);

  assert.equal(packageJson.version, EXPECTED_VERSION);
  assert.equal(packageLock.version, EXPECTED_VERSION);
  assert.equal(packageLock.packages[''].version, EXPECTED_VERSION);
  assert.equal(
    serviceWorker.includes(
      'const CACHE_NAME = `${CACHE_PREFIX}v' + EXPECTED_VERSION + '`;',
    ),
    true,
  );
});
