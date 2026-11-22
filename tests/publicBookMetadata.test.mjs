import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_CHECK_TITLE_NORMALIZER_VERSION,
  getPublicBookCoverCandidates,
  getPublicBookMetadataAliasCandidates,
  normalizePublicBookMetadataAlias,
  parsePublicBookMetadata,
} from '../src/lib/publicBookMetadataSchema.ts';

test('normalizes a filename into the bounded metadata alias contract', () => {
  assert.equal(
    normalizePublicBookMetadataAlias('마왕은 학원에 간다 1-703화 完.epub'),
    '마왕은학원에간다1703화完',
  );
});

test('adds a file_check-compatible core alias after the exact filename alias', () => {
  assert.equal(FILE_CHECK_TITLE_NORMALIZER_VERSION, '1.3.3');
  assert.deepEqual(
    getPublicBookMetadataAliasCandidates('주인공이 되기 위해 네토리합니다 1-231.epub'),
    ['주인공이되기위해네토리합니다1231', '주인공이되기위해네토리합니다'],
  );
  assert.deepEqual(
    getPublicBookMetadataAliasCandidates('마왕은 학원에 간다 1-703화 完.epub'),
    ['마왕은학원에간다1703화完', '마왕은학원에간다'],
  );
  assert.deepEqual(
    getPublicBookMetadataAliasCandidates('2회차 드래곤은 유희를 즐긴다.epub'),
    ['2회차드래곤은유희를즐긴다'],
  );
});

test('accepts a bounded public platform record and rejects unsafe URLs', () => {
  const payload = {
    schemaVersion: 1,
    titleKey: '마왕은학원에간다',
    displayTitle: '마왕은 학원에 간다',
    normalizerVersion: '1.3.3',
    publishedAt: '2026-08-14T00:00:00+00:00',
    platforms: [{
      platform: 'kakao',
      label: '카카오페이지',
      title: '마왕은 학원에 간다',
      url: 'https://page.kakao.com/content/1',
      coverUrl: 'https://dn-img-page.kakao.com/download/resource?kid=test&filename=o1',
      downloadCount: null,
      interestCount: null,
      viewCount: 123456,
      recommendCount: null,
      rating: 9.8,
      ratingCount: 42,
      lastSuccessAt: '2026-08-14T00:00:00+00:00',
    }],
  };
  assert.deepEqual(parsePublicBookMetadata(payload), payload);
  assert.equal(parsePublicBookMetadata({
    ...payload,
    platforms: [{ ...payload.platforms[0], url: 'javascript:alert(1)' }],
  }), null);
  assert.equal(parsePublicBookMetadata({
    ...payload,
    platforms: [{ ...payload.platforms[0], coverUrl: 'http://example.test/cover.jpg' }],
  }), null);

  const legacy = parsePublicBookMetadata({
    ...payload,
    platforms: [{
      ...payload.platforms[0],
      coverUrl: undefined,
    }],
  });
  assert.equal(legacy.platforms[0].coverUrl, null);
});

test('orders metadata cover candidates by stable platform priority', () => {
  const metadata = {
    schemaVersion: 1,
    titleKey: '작품',
    displayTitle: '작품',
    normalizerVersion: '1.3.3',
    publishedAt: '2026-08-22T00:00:00+00:00',
    platforms: [
      { platform: 'novelpia', coverUrl: 'https://novelpia.com/cover.jpg' },
      { platform: 'kakao', coverUrl: 'https://dn-img-page.kakao.com/cover.jpg' },
      { platform: 'series', coverUrl: 'https://comicthumb-phinf.pstatic.net/cover.jpg' },
    ],
  };
  assert.deepEqual(getPublicBookCoverCandidates(metadata), [
    { platform: 'series', coverUrl: 'https://comicthumb-phinf.pstatic.net/cover.jpg' },
    { platform: 'kakao', coverUrl: 'https://dn-img-page.kakao.com/cover.jpg' },
    { platform: 'novelpia', coverUrl: 'https://novelpia.com/cover.jpg' },
  ]);
});

test('default metadata reads share only concurrent document requests and retry after settlement', async () => {
  const { registerHooks } = await import('node:module');
  const firestoreStub = `export const doc = (_db, ...parts) => ({ path: parts.join('/') });
export const getDoc = (ref) => globalThis.publicMetadataTestRead(ref);`;
  const firebaseStub = `export const db = {}; export const auth = { currentUser: { getIdToken: async () => 'token' } };`;
  const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/src/lib/publicBookMetadata.ts')) {
        if (specifier === 'firebase/firestore') return { url: moduleUrl(firestoreStub), format: 'module', shortCircuit: true };
        if (specifier === './firebase') return { url: moduleUrl(firebaseStub), format: 'module', shortCircuit: true };
        if (specifier === './publicBookMetadataSchema') return nextResolve('./publicBookMetadataSchema.ts', context);
        if (specifier === './publicBookCatalog') return nextResolve('./publicBookCatalog.ts', context);
      }
      return nextResolve(specifier, context);
    },
  });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const missing = { exists: () => false, metadata: { fromCache: true } };
  globalThis.publicMetadataTestRead = async () => { calls++; await gate; return missing; };
  try {
    const { loadPublicBookMetadata, readDefaultPublicBookMetadataDocument, readSharedPublicBookMetadataDocument } = await import('../src/lib/publicBookMetadata.ts');
    const first = readDefaultPublicBookMetadataDocument({ path: 'publicBookMetadataV1/ab' });
    const second = readSharedPublicBookMetadataDocument({ path: 'publicBookMetadataV1/ab' });
    const other = readDefaultPublicBookMetadataDocument({ path: 'publicBookMetadataV1/cd' });
    assert.equal(calls, 2);
    release();
    assert.equal(await first, missing);
    assert.equal((await second).snapshot, missing);
    assert.equal(await other, missing);
    await readDefaultPublicBookMetadataDocument({ path: 'publicBookMetadataV1/ab' });
    assert.equal(calls, 3, 'a cache miss is not retained after the concurrent read settles');
    globalThis.publicMetadataTestRead = async () => { calls++; throw new Error('offline'); };
    await assert.rejects(readDefaultPublicBookMetadataDocument({ path: 'publicBookMetadataV1/ab' }), /offline/);
    await assert.rejects(readDefaultPublicBookMetadataDocument({ path: 'publicBookMetadataV1/ab' }), /offline/);
    assert.equal(calls, 5, 'failed reads are not retained');

    let releaseCallers;
    const callerGate = new Promise((resolve) => { releaseCallers = resolve; });
    const paths = [];
    globalThis.publicMetadataTestRead = async ({ path }) => { paths.push(path); await callerGate; return missing; };
    const info = loadPublicBookMetadata('작품.epub');
    const cover = loadPublicBookMetadata('작품.epub');
    while (!paths.length) await new Promise((resolve) => setImmediate(resolve));
    releaseCallers();
    assert.deepEqual(await Promise.all([info, cover]), [null, null]);
    assert.equal(paths.length, 2, 'the bucket and on-demand document each have one shared read');
    await loadPublicBookMetadata('작품.epub');
    assert.equal(paths.length, 4, 'a later caller performs new document reads');
  } finally {
    release();
    delete globalThis.publicMetadataTestRead;
    hooks.deregister();
  }
});
