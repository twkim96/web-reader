import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  normalizePlatformTitle,
  normalizeTags,
  parseCount,
  selectUniqueExactCandidate,
  titlesMatch,
} from '../src/server/bookMetadata/domain.ts';
import { parseBookMetadataRefreshRequest, withTrustedQueryTitle } from '../src/server/bookMetadata/requestSchema.ts';
import { novelpiaCredentialsConfigured } from '../src/server/bookMetadata/config.ts';
import {
  getKakaoCoverUrl,
  parseKakaoCandidates,
  parseKakaoOverview,
  parseKakaoTags,
  parseNovelpiaTags,
  parseOpenGraphCover,
  parseSeriesCandidates,
  parseSeriesDetail,
} from '../src/server/bookMetadata/crawlers.ts';
import { buildOnDemandMetadata } from '../src/server/bookMetadata/store.ts';

const fixture = async (name, json = false) => {
  const value = await readFile(resolve('tests/fixtures/bookMetadata', name), 'utf8');
  return json ? JSON.parse(value) : value;
};

test('normalizes presentation suffixes while preserving identity symbols', () => {
  assert.equal(normalizePlatformTitle('테스트 작품 (총 120화) [독점]'), '테스트작품');
  assert.equal(titlesMatch('A+B', 'A + B (총 3권)'), true);
  assert.equal(titlesMatch('A+B', 'AB'), false);
  assert.equal(parseCount('1억 2.5만'), 100_025_000);
  assert.deepEqual(normalizeTags(['#성장', ' 성장 ', '먼치킨']), ['성장', '먼치킨']);
});

test('rejects ambiguous exact title candidates instead of selecting the first', () => {
  assert.equal(selectUniqueExactCandidate('동명작', [
    { id: '1', title: '동명작' },
    { id: '2', title: '동명작 (총 10화)' },
  ]).status, 'ambiguous');
});

test('parses bounded refresh requests and deterministic aliases', () => {
  const parsed = parseBookMetadataRefreshRequest({ fileName: '테스트 작품.epub' });
  assert.match(parsed.aliasId, /^[0-9a-f]{64}$/);
  assert.equal(parsed.queryTitle, '테스트 작품');
  assert.equal(withTrustedQueryTitle(parsed, '검증된 작품').queryTitle, '검증된 작품');
  assert.equal(parseBookMetadataRefreshRequest({ fileName: '' }), null);
  assert.equal(parseBookMetadataRefreshRequest({ fileName: 'x', title: '다른 작품' }), null);
  assert.equal(parseBookMetadataRefreshRequest({ fileName: 'x', url: 'https://example.com' }), null);
  const ranged = parseBookMetadataRefreshRequest({ fileName: '회귀로 바로잡다 1-472.epub' });
  assert.equal(ranged.queryTitle, '회귀로 바로잡다');
  assert.equal(ranged.aliasId.length, 64);
});

test('NovelPia authentication is enabled only when both secrets exist', () => {
  assert.equal(novelpiaCredentialsConfigured({}), false);
  assert.equal(novelpiaCredentialsConfigured({ NOVELPIA_EMAIL: 'a@example.com' }), false);
  assert.equal(novelpiaCredentialsConfigured({ NOVELPIA_PASSWORD: 'secret' }), false);
  assert.equal(novelpiaCredentialsConfigured({ NOVELPIA_EMAIL: 'a@example.com', NOVELPIA_PASSWORD: 'secret' }), true);
});

test('parses the three public platform fixture shapes', async () => {
  const seriesCandidates = parseSeriesCandidates(await fixture('series-search.html'));
  assert.deepEqual(seriesCandidates, [{ id: '123', title: '테스트 작품 (총 120화)' }]);
  assert.deepEqual(parseSeriesDetail(await fixture('series-detail.html')), {
    title: '테스트 작품', sourceCount: 12000, genre: '현판',
    coverUrl: 'https://comicthumb-phinf.pstatic.net/test-cover.jpg',
  });
  assert.deepEqual(parseKakaoCandidates(await fixture('kakao-search.json', true)), [
    { id: '456', title: '테스트 작품', sourceCount: 25000 },
  ]);
  assert.deepEqual(parseKakaoOverview(await fixture('kakao-overview.json', true)), {
    title: '테스트 작품', sourceCount: 26000, genre: '현대판타지',
    coverUrl: getKakaoCoverUrl('sample/kakao-cover-key'),
  });
  assert.deepEqual(parseKakaoTags(await fixture('kakao-about.json', true)), ['성장', '먼치킨']);
  assert.deepEqual(parseNovelpiaTags((await fixture('novelpia-search.json', true)).list[0]), ['판타지', '하렘', '성장']);
  assert.equal(
    parseOpenGraphCover('<meta content="https://images.novelpia.com/cover.jpg" property="og:image">'),
    'https://images.novelpia.com/cover.jpg',
  );
  assert.equal(parseOpenGraphCover('<meta property="og:image" content="http://example.test/cover.jpg">'), null);
});

test('builds ready, ambiguous, and retryable results without inventing metadata', () => {
  const ok = { platform: 'kakao', status: 'ok', remoteId: '1', remoteTitle: '작품', url: 'https://page.kakao.com/content/1', coverUrl: 'https://dn-img-page.kakao.com/cover.jpg', genre: '판타지', tags: ['성장'], sourceCount: 10 };
  const notFound = (platform) => ({ platform, status: 'not-found', remoteId: null, remoteTitle: null, url: null, coverUrl: null, genre: null, tags: null, sourceCount: null });
  const ready = buildOnDemandMetadata('a'.repeat(64), 'b'.repeat(64), '작품', [notFound('series'), ok, notFound('novelpia')]);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.platforms[0].coverUrl, ok.coverUrl);
  assert.equal(buildOnDemandMetadata('a'.repeat(64), 'b'.repeat(64), '작품', [notFound('series'), { ...notFound('kakao'), status: 'ambiguous' }, notFound('novelpia')]).status, 'ambiguous');
});
