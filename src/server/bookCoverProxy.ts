export const BOOK_COVER_PROXY_MAX_BYTES = 10 * 1024 * 1024;

export const BOOK_COVER_PROXY_ALLOWED_HOSTS = new Set([
  'comicthumb-phinf.pstatic.net',
  'dn-img-page.kakao.com',
  'novelpia.com',
  'image.novelpia.com',
  'images.novelpia.com',
]);

export const parseBookCoverSourceUrl = (value: unknown) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !BOOK_COVER_PROXY_ALLOWED_HOSTS.has(url.hostname)) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
};

const bytesEqual = (bytes: Uint8Array, offset: number, expected: readonly number[]) => (
  expected.every((value, index) => bytes[offset + index] === value)
);

export const sniffBookCoverContentType = (bytes: Uint8Array) => {
  if (bytes.length >= 3 && bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (
    bytes.length >= 12
    && bytesEqual(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && bytesEqual(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) return 'image/webp';
  if (
    bytes.length >= 6
    && (
      bytesEqual(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      || bytesEqual(bytes, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    )
  ) return 'image/gif';
  if (
    bytes.length >= 12
    && bytesEqual(bytes, 4, [0x66, 0x74, 0x79, 0x70])
    && ['avif', 'avis'].includes(new TextDecoder('ascii').decode(bytes.slice(8, 12)))
  ) return 'image/avif';
  return null;
};
