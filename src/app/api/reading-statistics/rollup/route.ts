import { timingSafeEqual } from 'node:crypto';
import { getAdminAuth, getAdminFirestore } from '../../../../server/firebaseAdmin';
import { runReadingRollupCron } from '../../../../server/readingRollupStore';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (process.env.ENABLE_READING_STATS_ROLLUP !== '1' || !secret) return new Response(null, { status: 404 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response(null, { status: 401 });
  try {
    const outcomes = await runReadingRollupCron(getAdminFirestore(), {
      listAccounts: (limit, pageToken) => getAdminAuth().listUsers(limit, pageToken),
    });
    console.info('[reading-rollup] schedule result', outcomes);
    return Response.json(outcomes, { status: outcomes.failed ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
