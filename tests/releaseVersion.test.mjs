import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EXPECTED_VERSION = '1.7.10';

test('keeps package metadata and service worker cache on the release version', async () => {
  const [packageText, lockText, serviceWorker, browserRegression] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('./browserRegression.mjs', import.meta.url), 'utf8'),
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
});

test('bundles and precaches the Pretendard UI font with its license', async () => {
  const [globalStyles, settingsModal, serviceWorker, font, license] = await Promise.all([
    readFile(new URL('../src/app/globals.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/SettingsModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/fonts/PretendardVariable.woff2', import.meta.url)),
    readFile(new URL('../public/fonts/Pretendard-OFL.txt', import.meta.url), 'utf8'),
  ]);

  assert.match(globalStyles, /font-family: 'Pretendard Variable';/);
  assert.match(globalStyles, /font-weight: 45 920;/);
  assert.match(globalStyles, /--font-sans: 'Pretendard Variable', Pretendard,/);
  assert.match(globalStyles, /--text-xs: 0\.8125rem;/);
  assert.match(globalStyles, /--text-xs--line-height: 1rem;/);
  assert.match(globalStyles, /--text-sm: 0\.9375rem;/);
  assert.match(globalStyles, /--text-sm--line-height: 1\.25rem;/);
  assert.match(globalStyles, /--text-base: 1\.0625rem;/);
  assert.match(globalStyles, /--text-base--line-height: 1\.5rem;/);
  assert.match(globalStyles, /--text-lg: 1\.1875rem;/);
  assert.match(globalStyles, /--text-lg--line-height: 1\.75rem;/);
  assert.match(globalStyles, /--text-xl: 1\.3125rem;/);
  assert.match(globalStyles, /--text-xl--line-height: 1\.75rem;/);
  assert.match(globalStyles, /--text-2xl: 1\.5625rem;/);
  assert.match(globalStyles, /--text-2xl--line-height: 2rem;/);
  assert.match(globalStyles, /--text-4xl: 2\.3125rem;/);
  assert.match(globalStyles, /--text-4xl--line-height: 2\.5rem;/);
  assert.match(settingsModal, /labelStyle = "text-\[11px\]/);
  assert.match(settingsModal, /optionBtnStyle = `h-9 px-4 rounded-xl text-\[10px\]/);
  assert.match(serviceWorker, /'\/fonts\/PretendardVariable\.woff2'/);
  assert.match(serviceWorker, /OBSOLETE_PRECACHE_URLS = \['\/fonts\/SUIT-Variable\.woff2'\]/);
  assert.ok(font.byteLength > 1_000_000);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
