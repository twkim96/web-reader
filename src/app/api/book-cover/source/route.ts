import {
  BOOK_COVER_PROXY_MAX_BYTES,
  parseBookCoverSourceUrl,
  sniffBookCoverContentType,
} from '../../../../server/bookCoverProxy';

export const runtime = 'nodejs';
export const maxDuration = 20;

const REQUEST_MAX_BYTES = 4_096;
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const errorResponse = (status: number, message: string) => Response.json(
  { status: 'error', message },
  { status, headers: { 'Cache-Control': 'no-store' } },
);

export async function POST(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'invalid content type');
  }
  const declaredRequestBytes = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > REQUEST_MAX_BYTES) {
    return errorResponse(413, 'request too large');
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > REQUEST_MAX_BYTES) {
      return errorResponse(413, 'request too large');
    }
    body = JSON.parse(text);
  } catch {
    return errorResponse(400, 'invalid request');
  }
  const rawUrl = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).url
    : null;
  const sourceUrl = parseBookCoverSourceUrl(rawUrl);
  if (!sourceUrl) return errorResponse(400, 'cover URL is not allowed');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5',
        'User-Agent': USER_AGENT,
      },
    });
    if (!response.ok) return errorResponse(502, `cover HTTP ${response.status}`);
    if (!parseBookCoverSourceUrl(response.url)) {
      return errorResponse(502, 'cover redirect is not allowed');
    }
    const declaredSourceBytes = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSourceBytes) && declaredSourceBytes > BOOK_COVER_PROXY_MAX_BYTES) {
      return errorResponse(413, 'cover is too large');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > BOOK_COVER_PROXY_MAX_BYTES) {
      return errorResponse(buffer.byteLength === 0 ? 502 : 413, 'cover size is invalid');
    }
    const contentType = sniffBookCoverContentType(new Uint8Array(buffer));
    if (!contentType) return errorResponse(415, 'cover payload is not a supported image');
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return errorResponse(504, 'cover fetch timed out');
    console.warn('[BookCoverProxy] cover fetch failed:', error);
    return errorResponse(502, 'cover fetch failed');
  } finally {
    clearTimeout(timer);
  }
}
