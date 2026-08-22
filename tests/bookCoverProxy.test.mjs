import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_COVER_PROXY_MAX_BYTES,
  parseBookCoverSourceUrl,
  sniffBookCoverContentType,
} from '../src/server/bookCoverProxy.ts';

test('allows only known HTTPS cover hosts', () => {
  assert.equal(
    parseBookCoverSourceUrl('https://comicthumb-phinf.pstatic.net/a.jpg')?.hostname,
    'comicthumb-phinf.pstatic.net',
  );
  assert.equal(
    parseBookCoverSourceUrl('https://dn-img-page.kakao.com/download/resource?kid=x&filename=o1')?.hostname,
    'dn-img-page.kakao.com',
  );
  assert.equal(parseBookCoverSourceUrl('https://novelpia.com/imagebox/cover/a.file')?.hostname, 'novelpia.com');
  assert.equal(parseBookCoverSourceUrl('https://image.novelpia.com/imagebox/cover/a.file')?.hostname, 'image.novelpia.com');
  assert.equal(parseBookCoverSourceUrl('https://images.novelpia.com/a.jpg')?.hostname, 'images.novelpia.com');
  assert.equal(parseBookCoverSourceUrl('http://novelpia.com/a.jpg'), null);
  assert.equal(parseBookCoverSourceUrl('https://example.com/a.jpg'), null);
  assert.equal(parseBookCoverSourceUrl('https://user:pass@novelpia.com/a.jpg'), null);
  assert.equal(BOOK_COVER_PROXY_MAX_BYTES, 10 * 1024 * 1024);
});

test('sniffs image bytes instead of trusting upstream content type', () => {
  assert.equal(sniffBookCoverContentType(Uint8Array.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(sniffBookCoverContentType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffBookCoverContentType(Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ])), 'image/webp');
  assert.equal(sniffBookCoverContentType(new TextEncoder().encode('not an image')), null);
});
