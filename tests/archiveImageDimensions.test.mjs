import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ARCHIVE_IMAGE_DIMENSION,
  MAX_ARCHIVE_IMAGE_PIXELS,
  exceedsArchiveImageLimits,
  probeArchiveImageDimensions,
} from '../src/lib/archiveImageDimensions.ts';

const png = (width, height) => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  new DataView(bytes.buffer).setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
};

const gif = (width, height) => {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode('GIF89a'));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return new Blob([bytes], { type: 'image/gif' });
};

const bmp = (width, height) => {
  const bytes = new Uint8Array(26);
  bytes.set([0x42, 0x4d]);
  const view = new DataView(bytes.buffer);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, -height, true);
  return new Blob([bytes], { type: 'image/bmp' });
};

const jpeg = (width, height, appPayloadLength = 4) => {
  const appLength = appPayloadLength + 2;
  const prefix = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, appLength >> 8, appLength & 0xff,
  ]);
  const suffix = new Uint8Array([
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    0xff, 0xd9,
  ]);
  return new Blob(
    [prefix, new Uint8Array(appPayloadLength), suffix],
    { type: 'image/jpeg' },
  );
};

const webpVp8x = (width, height) => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8X'), 12);
  const writeUint24 = (offset, value) => {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  };
  writeUint24(24, width - 1);
  writeUint24(27, height - 1);
  return new Blob([bytes], { type: 'image/webp' });
};

const webpVp8 = (width, height) => {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8 '), 12);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes[26] = width & 0xff;
  bytes[27] = (width >> 8) & 0x3f;
  bytes[28] = height & 0xff;
  bytes[29] = (height >> 8) & 0x3f;
  return new Blob([bytes], { type: 'image/webp' });
};

const webpVp8l = (width, height) => {
  const bytes = new Uint8Array(25);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  bytes.set(new TextEncoder().encode('WEBP'), 8);
  bytes.set(new TextEncoder().encode('VP8L'), 12);
  bytes[20] = 0x2f;
  const packed = ((height - 1) << 14) | (width - 1);
  new DataView(bytes.buffer).setUint32(21, packed, true);
  return new Blob([bytes], { type: 'image/webp' });
};

test('reads dimensions without decoding common archive image formats', async () => {
  const fixtures = [
    [png(2400, 3600), 'image/png'],
    [jpeg(2400, 3600), 'image/jpeg'],
    [gif(2400, 3600), 'image/gif'],
    [bmp(2400, 3600), 'image/bmp'],
    [webpVp8(2400, 3600), 'image/webp'],
    [webpVp8l(2400, 3600), 'image/webp'],
    [webpVp8x(2400, 3600), 'image/webp'],
  ];

  for (const [blob, mimeType] of fixtures) {
    assert.deepEqual(
      await probeArchiveImageDimensions(blob, mimeType),
      { width: 2400, height: 3600 },
      mimeType,
    );
  }
});

test('skips JPEG metadata without reading the image payload', async () => {
  const source = jpeg(2400, 3600, 60_000);
  const ranges = [];
  const trackedBlob = new Proxy(source, {
    get(target, property) {
      if (property === 'slice') {
        return (start, end) => {
          ranges.push([start, end]);
          return target.slice(start, end);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.deepEqual(
    await probeArchiveImageDimensions(trackedBlob, 'image/jpeg'),
    { width: 2400, height: 3600 },
  );
  assert.ok(ranges.every(([start, end]) => end - start <= 16));
  assert.ok(ranges.reduce((total, [start, end]) => total + end - start, 0) < 100);
});

test('accepts the exact archive image pixel boundary', () => {
  assert.equal(exceedsArchiveImageLimits({
    width: 8192,
    height: 8192,
  }), false);
  assert.equal(8192 * 8192, MAX_ARCHIVE_IMAGE_PIXELS);
});

test('rejects pixel and single-dimension limits independently', () => {
  assert.equal(exceedsArchiveImageLimits({
    width: 8193,
    height: 8192,
  }), true);
  assert.equal(exceedsArchiveImageLimits({
    width: MAX_ARCHIVE_IMAGE_DIMENSION + 1,
    height: 1,
  }), true);
});

test('leaves AVIF and unrecognized headers on the existing byte-size guard', async () => {
  assert.equal(
    await probeArchiveImageDimensions(
      new Blob(['avif'], { type: 'image/avif' }),
      'image/avif',
    ),
    null,
  );
  assert.equal(
    await probeArchiveImageDimensions(new Blob(['not png']), 'image/png'),
    null,
  );
});
