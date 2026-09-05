export class ResponseSizeError extends Error {
  constructor() { super('response is too large'); }
}

/** Enforce the cap during streaming, even when Content-Length is absent or false. */
export const readBoundedBody = async (response: Response, maxBytes: number) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ResponseSizeError();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ResponseSizeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/** Validate each redirect before issuing a request to its destination. */
export const fetchAllowedRedirects = async (
  input: URL,
  options: RequestInit,
  isAllowed: (url: URL) => boolean,
) => {
  let url = input;
  for (let hop = 0; hop <= 5; hop += 1) {
    if (!isAllowed(url)) throw new Error('redirect URL is not allowed');
    const response = await fetch(url, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || hop === 5) throw new Error('invalid or excessive redirects');
    url = new URL(location, url);
  }
  throw new Error('excessive redirects');
};
