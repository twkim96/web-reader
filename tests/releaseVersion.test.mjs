import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXPECTED_VERSION = '1.8.12';

test('keeps package metadata and service worker cache on the release version', async () => {
  const [packageText, lockText, serviceWorker, browserRegression, foliateRuntime, foliateView] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('./browserRegression.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/foliateRuntimeCache.ts', import.meta.url), 'utf8'),
    readFile(new URL('../public/foliate-js/view.js', import.meta.url), 'utf8'),
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
  assert.equal(
    browserRegression.includes(`const expectedCache = 'pc-reader-v${EXPECTED_VERSION}';`),
    true,
  );
  assert.equal(
    browserRegression.includes(`/sw.js?browser-regression=${EXPECTED_VERSION}`),
    true,
  );
  assert.equal(
    browserRegression.includes(
      `browser-regression=${EXPECTED_VERSION.replaceAll('.', '\\.')}$/`,
    ),
    true,
  );
  assert.equal(
    foliateRuntime.includes(`FOLIATE_RUNTIME_VERSION = '${EXPECTED_VERSION}'`),
    true,
  );
  assert.equal(
    foliateRuntime.includes("FOLIATE_RUNTIME_REVISION = '1.8.12.1'"),
    true,
  );
  assert.equal(
    foliateRuntime.includes('FOLIATE_ENTRY_URL = `/foliate-js/view.js?v=${FOLIATE_RUNTIME_REVISION}`'),
    true,
  );
  assert.equal(
    foliateView.includes("import('./paginator.js?v=1.8.12.1')"),
    true,
  );
});

test('bundles and precaches the Pretendard UI font with its license', async () => {
  const [globalStyles, serviceWorker, font, license] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/fonts/PretendardVariable.woff2', import.meta.url)),
    readFile(new URL('../public/fonts/Pretendard-OFL.txt', import.meta.url), 'utf8'),
  ]);

  assert.match(globalStyles, /font-family: 'Pretendard Variable';/);
  assert.match(globalStyles, /font-weight: 45 920;/);
  assert.match(globalStyles, /--font-sans: 'Pretendard Variable', Pretendard,/);
  assert.match(serviceWorker, /'\/fonts\/PretendardVariable\.woff2'/);
  assert.match(serviceWorker, /OBSOLETE_PRECACHE_URLS = \['\/fonts\/SUIT-Variable\.woff2'\]/);
  assert.ok(font.byteLength > 1_000_000);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('opens publication external links without exposing the reader opener', async () => {
  const viewSource = await readFile(
    new URL('../public/foliate-js/view.js', import.meta.url),
    'utf8',
  );
  assert.match(
    viewSource,
    /globalThis\.open\(\s*resolvedURL\.href, '_blank', 'noopener,noreferrer'\)/,
  );
  assert.match(viewSource, /if \(opened\) opened\.opener = null/);
  assert.match(viewSource, /resolvedURL\.protocol !== 'http:'/);
  assert.match(viewSource, /resolvedURL\.protocol !== 'https:'/);
});
