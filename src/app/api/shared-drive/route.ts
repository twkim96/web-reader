import { createHash, randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '../../../server/firebaseAdmin';
import { getDriveUserPermissionId, isGoogleDriveAuthError } from '../../../lib/googleDrive';
import {
  canReadSharedFolder, copySharedFiles, COPY_LIMIT, generateCopyIds, isDriveId, searchSharedFolder, SharedDriveError,
} from '../../../server/sharedDrive/google';

const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const json = (body: object, status = 200) => Response.json(body, { status, headers });
const fail = (status: number, reason?: 'origin' | 'account' | 'folder' | 'drive' | 'destination-changed') =>
  json({ error: 'shared-drive-unavailable', ...(reason && { reason }) }, status);
export const maxDuration = 45;
const COPY_RETRY_WINDOW_MS = 10 * 60_000;
const MAX_RECENT_COPIES = 128;
type RecentCopy = { id: string; until: number; sourceKey?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

function config() {
  const folderId = process.env.WEB_READER_SHARED_DRIVE_FOLDER_ID?.trim();
  const allowedUids = process.env.WEB_READER_SHARED_DRIVE_ALLOWED_UIDS?.split(',').map((uid) => uid.trim()).filter(Boolean);
  const pickerKey = process.env.WEB_READER_SHARED_DRIVE_PICKER_KEY?.trim();
  const appId = process.env.WEB_READER_SHARED_DRIVE_PICKER_APP_ID?.trim();
  if (!isDriveId(folderId) || !allowedUids?.length || !pickerKey || !appId || !/^\d+$/.test(appId)) return null;
  return { folderId, allowedUids, pickerKey, appId };
}

async function authorize(request: Request, allowedUids: string[]) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const driveToken = request.headers.get('x-drive-access-token');
  if (!token || !driveToken || !/^[A-Za-z0-9._~-]{10,4096}$/.test(driveToken)) return null;
  try {
    const auth = await getAdminAuth().verifyIdToken(token, true);
    return auth.firebase.sign_in_provider !== 'anonymous' && allowedUids.includes(auth.uid) ? driveToken : null;
  } catch {
    return null;
  }
}

async function copy(token: string, folderId: string, ids: string[], signal: AbortSignal) {
  const permissionId = await getDriveUserPermissionId(token, signal);
  const key = hash(permissionId);
  const db = getAdminFirestore();
  const ref = db.collection('sharedDriveImportLocksV1').doc(key);
  const lease = randomUUID();
  const acquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const leaseUntil = snapshot.get('leaseUntil') as Timestamp | undefined;
    const now = Date.now();
    if ((leaseUntil?.toMillis() ?? 0) > now) return false;
    transaction.set(ref, {
      lease, leaseUntil: Timestamp.fromMillis(now + 60_000), expiresAt: Timestamp.fromMillis(now + COPY_RETRY_WINDOW_MS + 60_000),
    }, { merge: true });
    return true;
  });
  if (!acquired) return fail(409);
  try {
    const results = await copySharedFiles(token, folderId, ids, permissionId, signal, async (destination, sources) => {
      const snapshot = await ref.get();
      if (snapshot.get('lease') !== lease) throw new SharedDriveError(409);
      const now = Date.now();
      const previous = snapshot.get('recentCopies') as Record<string, RecentCopy> | undefined;
      const recent = new Map(Object.entries(previous ?? {}).filter(([, entry]) => entry.until > now));
      const keyFor = (source: string) => hash(`${destination}:${source}`);
      const recordedDestinations = new Map([...recent].flatMap(([key, entry]) => entry.sourceKey ? [[entry.sourceKey, key]] : []));
      const missing = sources.filter((source) => {
        const recorded = recordedDestinations.get(hash(source));
        if (recorded && recorded !== keyFor(source)) throw new SharedDriveError(409, 'destination-changed');
        return !recent.has(keyFor(source));
      });
      if (recent.size + missing.length > MAX_RECENT_COPIES) throw new SharedDriveError(429);
      if (missing.length) {
        const generated = await generateCopyIds(token, missing.length, signal);
        for (const [index, source] of missing.entries()) {
          recent.set(keyFor(source), { id: generated[index], until: now + COPY_RETRY_WINDOW_MS, sourceKey: hash(source) });
        }
        await db.runTransaction(async (transaction) => {
          if ((await transaction.get(ref)).get('lease') !== lease) throw new SharedDriveError(409);
          transaction.update(ref, { recentCopies: Object.fromEntries(recent) });
        });
      }
      return new Map(sources.map((source) => [source, recent.get(keyFor(source))!.id]));
    });
    return json({ results });
  } finally {
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.get('lease') !== lease) return;
      if (snapshot.get('recentCopies')) transaction.update(ref, { lease: '', leaseUntil: Timestamp.fromMillis(0) });
      else transaction.delete(ref);
    }).catch(() => {});
  }
}

export async function GET(request: Request) {
  const settings = config();
  if (!settings) return json({ available: false });
  const token = await authorize(request, settings.allowedUids);
  if (!token) return json({ available: false });
  try {
    const available = await canReadSharedFolder(token, settings.folderId, request.signal);
    return json(available ? { available, pickerKey: settings.pickerKey, appId: settings.appId } : { available });
  } catch (error) {
    return fail(error instanceof SharedDriveError && [401, 429].includes(error.status) ? error.status : 503, 'drive');
  }
}

export async function POST(request: Request) {
  const settings = config();
  if (!settings) return fail(404);
  // Vercel can forward a branch alias request under the deployment's internal URL.
  const branchUrl = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_BRANCH_URL : undefined;
  const origin = branchUrl ? `https://${branchUrl}` : new URL(request.url).origin;
  if (request.headers.get('origin') !== origin) return fail(403, 'origin');
  const token = await authorize(request, settings.allowedUids);
  if (!token) return fail(403, 'account');
  if (!request.headers.get('content-type')?.startsWith('application/json')) return fail(415);
  try {
    const raw = await request.text();
    if (raw.length > 4096) return fail(413);
    const body = JSON.parse(raw) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400);
    const { action, query, ids } = body;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    if (!(await canReadSharedFolder(token, settings.folderId, signal))) return fail(403, 'folder');
    if (action === 'search' && typeof query === 'string') {
      const title = query.trim();
      if (!title || title.length > 200 || /[\u0000-\u001f]/.test(title)) return fail(400);
      return json(await searchSharedFolder(token, settings.folderId, title, signal));
    }
    if (action === 'copy' && Array.isArray(ids) && ids.length > 0 && ids.length <= COPY_LIMIT
      && ids.every(isDriveId) && new Set(ids).size === ids.length) {
      return await copy(token, settings.folderId, ids, signal);
    }
    return fail(400);
  } catch (error) {
    if (error instanceof SharedDriveError) {
      if (error.reason === 'destination-changed') return fail(409, 'destination-changed');
      if (process.env.VERCEL_ENV === 'preview') console.warn('[SharedDrive] Google API', error.status, error.reason ?? 'unspecified');
      return fail(error.status, 'drive');
    }
    if (isGoogleDriveAuthError(error)) return fail(401, 'drive');
    return fail(error instanceof SyntaxError ? 400 : 503);
  }
}
