import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePublicBookMetadataAlias,
  parsePublicBookMetadata,
} from '../src/lib/publicBookMetadataSchema.ts';

test('normalizes a filename into the bounded metadata alias contract', () => {
  assert.equal(
    normalizePublicBookMetadataAlias('마왕은 학원에 간다 1-703화 完.epub'),
    '마왕은학원에간다1703화完',
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
});
