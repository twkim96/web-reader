import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminFirestore } from '../../../../server/firebaseAdmin';
import { BOOK_METADATA_LIMITS, createNovelpiaAuthProvider } from '../../../../server/bookMetadata/config';
import { crawlPublicBookMetadata } from '../../../../server/bookMetadata/crawlers';
import { parseBookMetadataRefreshRequest, withTrustedQueryTitle } from '../../../../server/bookMetadata/requestSchema';
import {
  acquireMetadataLease,
  buildOnDemandMetadata,
  recoverPendingCatalogPublication,
  saveMetadataAndPublish,
  waitForMetadataLease,
} from '../../../../server/bookMetadata/store';

export const runtime = 'nodejs';
export const maxDuration = 60;

const response = (body: object, status = 200) => NextResponse.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store' },
});

export async function POST(request: Request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return response({ status: 'invalid-request' }, 415);
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > BOOK_METADATA_LIMITS.bodyBytes) {
    return response({ status: 'invalid-request' }, 413);
  }
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return response({ status: 'unauthorized' }, 401);
  let uid: string;
  try {
    uid = (await getAdminAuth().verifyIdToken(token, true)).uid;
  } catch {
    return response({ status: 'unauthorized' }, 401);
  }
  let rawBody: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > BOOK_METADATA_LIMITS.bodyBytes) return response({ status: 'invalid-request' }, 413);
    rawBody = JSON.parse(text);
  } catch {
    return response({ status: 'invalid-request' }, 400);
  }
  const parsedInput = parseBookMetadataRefreshRequest(rawBody);
  if (!parsedInput) return response({ status: 'invalid-request' }, 400);
  const db = getAdminFirestore();
  const trustedMetadata = await db.collection('publicBookMetadataV1').doc(parsedInput.aliasId.slice(0, 2)).get();
  const trustedEntry = trustedMetadata.data()?.entries?.[parsedInput.aliasId] as Record<string, unknown> | undefined;
  const trustedTitle = typeof trustedEntry?.displayTitle === 'string'
    ? trustedEntry.displayTitle
    : Array.isArray(trustedEntry?.platforms) && typeof (trustedEntry.platforms[0] as Record<string, unknown> | undefined)?.title === 'string'
      ? (trustedEntry.platforms[0] as Record<string, unknown>).title
      : null;
  const input = withTrustedQueryTitle(parsedInput, trustedTitle);
  const lease = await acquireMetadataLease(db, input.aliasId, uid);
  if (lease.kind === 'cached') {
    let document = lease.document;
    let generation = null;
    if (document.publishPending) {
      try {
        generation = await recoverPendingCatalogPublication(db, document);
        document = { ...document, publishPending: false };
      } catch {
        return response({ status: 'error' }, 502);
      }
    }
    return response({ status: document.status, document, generation, cached: true });
  }
  if (lease.kind === 'quota') return response({ status: 'quota' }, 429);
  if (lease.kind === 'cooldown') return response({ status: 'cooldown' }, 429);
  if (lease.kind === 'busy') {
    const document = await waitForMetadataLease(db, input.aliasId);
    return document ? response({ status: document.status, document, cached: true }) : response({ status: 'busy' }, 202);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BOOK_METADATA_LIMITS.overallTimeoutMs);
  try {
    const results = await crawlPublicBookMetadata(input.queryTitle, controller.signal, createNovelpiaAuthProvider());
    const document = buildOnDemandMetadata(input.aliasId, input.canonicalKey, input.queryTitle, results);
    const generation = await saveMetadataAndPublish(db, document, lease.owner);
    return response({ status: document.status, document: { ...document, publishPending: false }, generation, cached: false });
  } catch {
    console.error('[BookMetadata] refresh failed');
    return response({ status: 'error' }, 502);
  } finally {
    clearTimeout(timer);
  }
}
