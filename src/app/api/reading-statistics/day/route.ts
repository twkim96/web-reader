import { parseReadingDaySession, readingDayWritesEnabled } from '../../../../lib/readingStatisticsDay';
import { readBoundedBody, ResponseSizeError } from '../../../../server/boundedFetch';
import { getAdminAuth, getAdminFirestore } from '../../../../server/firebaseAdmin';
import { appendReadingDaySession } from '../../../../server/readingStatisticsDayStore';

export const runtime = 'nodejs';
const bodyLimit = 64 * 1024;
const json = (body: object, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store' },
});

export async function POST(request: Request) {
  if (!readingDayWritesEnabled()) return json({ error: 'reading-day-write-disabled' }, 503);
  const token = request.headers.get('authorization')?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) return json({ error: 'unauthorized' }, 401);
  let uid: string;
  try {
    const account = await getAdminAuth().verifyIdToken(token, true);
    if (account.firebase.sign_in_provider === 'anonymous' || account.uid.includes('/')
      || account.uid === '.' || account.uid === '..' || /^__.*__$/.test(account.uid)) {
      return json({ error: 'unauthorized' }, 401);
    }
    uid = account.uid;
  } catch {
    return json({ error: 'unauthorized' }, 401);
  }

  let parsed: Awaited<ReturnType<typeof parseReadingDaySession>>;
  try {
    const bytes = await readBoundedBody(request, bodyLimit);
    parsed = await parseReadingDaySession(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    return error instanceof ResponseSizeError
      ? json({ error: 'body-too-large' }, 413)
      : json({ error: 'invalid-reading-session' }, 400);
  }
  try {
    return json(await appendReadingDaySession(getAdminFirestore(), uid, parsed));
  } catch (error) {
    if (error instanceof RangeError) return json({ error: 'reading-day-capacity' }, 422);
    return json({ error: 'reading-day-unavailable' }, 503);
  }
}
