export const MAX_ARCHIVE_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_ARCHIVE_IMAGE_DIMENSION = 32_768;

export type ImageDimensions = {
  width: number;
  height: number;
};

const readBytes = async (blob: Blob, start: number, length: number) => (
  new Uint8Array(await blob.slice(start, start + length).arrayBuffer())
);

const readUint24LE = (bytes: Uint8Array, offset: number) => (
  bytes[offset]
  | (bytes[offset + 1] << 8)
  | (bytes[offset + 2] << 16)
);

const validDimensions = (
  width: number,
  height: number,
): ImageDimensions | null => (
  Number.isSafeInteger(width)
  && Number.isSafeInteger(height)
  && width > 0
  && height > 0
    ? { width, height }
    : null
);

const probePng = async (blob: Blob) => {
  const bytes = await readBytes(blob, 0, 24);
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 24
    || pngSignature.some((value, index) => bytes[index] !== value)
    || new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8) !== 13
    || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR'
  ) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validDimensions(view.getUint32(16), view.getUint32(20));
};

const probeGif = async (blob: Blob) => {
  const bytes = await readBytes(blob, 0, 10);
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  if (bytes.length < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validDimensions(view.getUint16(6, true), view.getUint16(8, true));
};

const probeBmp = async (blob: Blob) => {
  const bytes = await readBytes(blob, 0, 26);
  if (bytes.length < 22 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) {
    return validDimensions(
      view.getUint16(18, true),
      view.getUint16(20, true),
    );
  }
  if (dibSize < 40 || bytes.length < 26) return null;

  return validDimensions(
    Math.abs(view.getInt32(18, true)),
    Math.abs(view.getInt32(22, true)),
  );
};

const probeWebp = async (blob: Blob) => {
  const bytes = await readBytes(blob, 0, 30);
  if (
    bytes.length < 16
    || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF'
    || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP'
  ) return null;

  const chunkType = String.fromCharCode(...bytes.slice(12, 16));
  if (chunkType === 'VP8X' && bytes.length >= 30) {
    return validDimensions(
      readUint24LE(bytes, 24) + 1,
      readUint24LE(bytes, 27) + 1,
    );
  }
  if (chunkType === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = (
      bytes[21]
      | (bytes[22] << 8)
      | (bytes[23] << 16)
      | (bytes[24] << 24)
    ) >>> 0;
    return validDimensions(
      (packed & 0x3fff) + 1,
      ((packed >>> 14) & 0x3fff) + 1,
    );
  }
  if (
    chunkType === 'VP8 '
    && bytes.length >= 30
    && bytes[23] === 0x9d
    && bytes[24] === 0x01
    && bytes[25] === 0x2a
  ) {
    return validDimensions(
      (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    );
  }
  return null;
};

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

const probeJpeg = async (blob: Blob) => {
  const signature = await readBytes(blob, 0, 2);
  if (signature[0] !== 0xff || signature[1] !== 0xd8) return null;

  let offset = 2;
  for (let markerCount = 0; markerCount < 512 && offset < blob.size; markerCount += 1) {
    let markerBytes = await readBytes(blob, offset, 4);
    const prefixOffset = markerBytes.findIndex((value) => value === 0xff);
    if (prefixOffset < 0) return null;
    offset += prefixOffset;

    markerBytes = await readBytes(blob, offset, 16);
    let markerOffset = 1;
    while (markerOffset < markerBytes.length && markerBytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = markerBytes[markerOffset];
    if (marker === undefined || marker === 0x00) return null;
    offset += markerOffset - 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }

    const segmentHeader = await readBytes(blob, offset, 9);
    if (segmentHeader.length < 4) return null;
    const segmentLength = (segmentHeader[2] << 8) | segmentHeader[3];
    if (segmentLength < 2 || offset + segmentLength + 2 > blob.size) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentHeader.length < 9 || segmentLength < 7) return null;
      return validDimensions(
        (segmentHeader[7] << 8) | segmentHeader[8],
        (segmentHeader[5] << 8) | segmentHeader[6],
      );
    }
    offset += segmentLength + 2;
  }
  return null;
};

export const probeArchiveImageDimensions = async (
  blob: Blob,
  mimeType: string,
): Promise<ImageDimensions | null> => {
  try {
    if (mimeType === 'image/png') return probePng(blob);
    if (mimeType === 'image/jpeg') return probeJpeg(blob);
    if (mimeType === 'image/gif') return probeGif(blob);
    if (mimeType === 'image/bmp') return probeBmp(blob);
    if (mimeType === 'image/webp') return probeWebp(blob);
    return null;
  } catch {
    return null;
  }
};

export const exceedsArchiveImageLimits = ({
  width,
  height,
}: ImageDimensions) => (
  width > MAX_ARCHIVE_IMAGE_DIMENSION
  || height > MAX_ARCHIVE_IMAGE_DIMENSION
  || width * height > MAX_ARCHIVE_IMAGE_PIXELS
);
