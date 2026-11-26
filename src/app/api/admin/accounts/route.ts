import { APP_ID } from '../../../../lib/appIdentity';
import type { AdminAccountsOverview, AdminRollupStatus } from '../../../../lib/adminAccounts';
import { parseReadingRollupMonday, readingRollupDayKey } from '../../../../lib/readingStatisticsRollup';
import { adminAccountHash, configuredAdminHash } from '../../../../server/adminAccess';
import { getAdminAuth, getAdminFirestore } from '../../../../server/firebaseAdmin';

const dayMs = 86_400_000;
const kstOffsetMs = 9 * 3_600_000;
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
const json = (body: object, status = 200) => Response.json(body, { headers, status });

async function readOverview(now: number): Promise<AdminAccountsOverview> {
  const today = Math.floor((now + kstOffsetMs) / dayMs) * dayMs - kstOffsetMs;
  const weekStart = today - 6 * dayMs;
  const monthStart = today - 29 * dayMs;
  const activity = { today: 0, week: 0, month: 0 };
  const accounts: AdminAccountsOverview['accounts'] = [];
  let pageToken: string | undefined;
  do {
    const page = await getAdminAuth().listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.disabled || user.providerData.length === 0) continue;
      const lastSignIn = Date.parse(user.metadata.lastSignInTime);
      if (!Number.isFinite(lastSignIn) || lastSignIn > now) continue;
      if (lastSignIn >= today) activity.today++;
      if (lastSignIn >= weekStart) activity.week++;
      if (lastSignIn < monthStart) continue;
      activity.month++;
      const refresh = Date.parse(user.metadata.lastRefreshTime ?? '');
      const lastRefresh = Number.isFinite(refresh) && refresh <= now ? refresh : null;
      accounts.push({ uid: user.uid, label: user.displayName || user.email || user.uid,
        email: user.displayName ? user.email ?? null : null, lastSignIn, lastRefresh });
    }
    pageToken = page.pageToken;
  } while (pageToken);
  accounts.sort((a, b) => b.lastSignIn - a.lastSignIn || a.uid.localeCompare(b.uid));
  return { activity, accounts };
}

async function readRollup(uid: string): Promise<AdminRollupStatus> {
  const db = getAdminFirestore();
  const job = db.doc(`artifacts/${APP_ID}/readingStatsRollupJobsV1/${uid}`);
  const [schedule, manifest] = await db.getAll(job, job.collection('readingStatsRollupManifestsV1').doc('current'),
    { fieldMask: ['dueAt', 'bootstrapDueAt', 'blocked', 'firstWeek', 'publishedThroughWeek'] });
  const blockedReason = schedule.get('blocked');
  const state = blockedReason ? 'blocked' : schedule.get('bootstrapDueAt') !== undefined ? 'preparing'
    : schedule.exists ? 'scheduled' : 'unregistered';
  const due = schedule.get('dueAt') ?? schedule.get('bootstrapDueAt');
  // Queue priorities occupy the last millisecond before the actual cutoff.
  const nextDue = typeof due === 'number' && Number.isFinite(due) ? Math.ceil(due) : null;
  let weeks: AdminRollupStatus['weeks'] = [];
  const publishedThrough = manifest.exists ? manifest.get('publishedThroughWeek') as string : null;
  if (publishedThrough) {
    const latest = parseReadingRollupMonday(publishedThrough);
    const first = parseReadingRollupMonday(manifest.get('firstWeek'));
    const collection = job.collection('readingStatsRollupWeeksV1');
    const refs = [collection.doc(publishedThrough)];
    if (latest > first) refs.push(collection.doc(readingRollupDayKey(latest - 7 * dayMs)));
    const snapshots = await db.getAll(...refs, { fieldMask: ['weekStart'] });
    weeks = snapshots.filter((doc) => doc.exists).map((doc) => ({ start: doc.id, writtenAt: doc.updateTime?.toMillis() ?? null }));
  }
  return {
    publishedThrough,
    nextDue,
    state,
    blockedReason: typeof blockedReason === 'string' ? blockedReason : null,
    weeks,
  };
}

export async function GET(request: Request) {
  const adminHash = configuredAdminHash();
  if (!adminHash) return json({ error: 'unavailable' }, 404);
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return json({ error: 'unauthenticated' }, 401);
  try {
    const account = await getAdminAuth().verifyIdToken(token, true);
    if (account.firebase.sign_in_provider === 'anonymous' || adminAccountHash(account.uid) !== adminHash) {
      return json({ error: 'forbidden' }, 403);
    }
  } catch {
    return json({ error: 'unauthenticated' }, 401);
  }

  const uid = new URL(request.url).searchParams.get('uid');
  try {
    if (uid === null) return json(await readOverview(Date.now()));
    if (!uid || uid.length > 128 || uid.includes('/') || uid === '.' || uid === '..' || /^__.*__$/.test(uid)) {
      return json({ error: 'invalid-account' }, 400);
    }
    return json(await readRollup(uid));
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
}
