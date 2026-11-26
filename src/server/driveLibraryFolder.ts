import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import {
  createReservedDriveLibraryFolder,
  generateDriveLibraryFolderId,
  getDriveLibraryFolderId,
  invalidateDriveCache,
  readReservedDriveLibraryFolder,
} from '../lib/googleDrive';
import { getAdminFirestore } from './firebaseAdmin';

// Both entry points have a 45s runtime limit. Keep the lease beyond that
// window and retain the ID even if a Drive write outlives the request.
const LEASE_MS = 60_000;

export class DriveLibraryFolderBusyError extends Error {}

export function isDriveFolderCoordinationConfigured() {
  return Boolean(
    process.env.WEB_READER_SHARED_DRIVE_FOLDER_ID?.trim()
    || process.env.WEB_READER_SHARED_DRIVE_PICKER_KEY?.trim()
    || process.env.WEB_READER_SHARED_DRIVE_PICKER_APP_ID?.trim()
    || process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON?.trim()
    || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
    || process.env.FIRESTORE_EMULATOR_HOST?.trim()
    || process.env.WEB_READER_DRIVE_FOLDER_COORDINATION === '1',
  );
}

export function isSameDriveRequestOrigin(request: Request) {
  const branchUrl = process.env.VERCEL_ENV === 'preview' ? process.env.VERCEL_BRANCH_URL : undefined;
  const origin = branchUrl ? `https://${branchUrl}` : new URL(request.url).origin;
  return request.headers.get('origin') === origin;
}

export async function resolveCoordinatedDriveLibraryFolder(
  token: string,
  permissionId: string,
  signal: AbortSignal,
  requireRegistryAccess = false,
): Promise<string> {
  const account = createHash('sha256').update(permissionId).digest('base64url');
  const db = getAdminFirestore();
  const ref = db.collection('driveLibraryFolderCoordinationV1').doc(account);
  const lease = randomUUID();
  const acquired = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    signal.throwIfAborted();
    const now = Date.now();
    if ((snapshot.get('leaseUntil') ?? 0) > now) throw new DriveLibraryFolderBusyError();
    transaction.set(ref, { lease, leaseUntil: now + LEASE_MS }, { merge: true });
    return snapshot.get('reservedId') as string | undefined;
  });

  const cacheKey = `coordination:${lease}`;
  try {
    const folderId = await getDriveLibraryFolderId(token, {
      cacheKey,
      signal,
      requireRegistryAccess,
      createIfMissing: true,
      recoverReservedFolder: async () => acquired ? readReservedDriveLibraryFolder(token, acquired, signal) : null,
      createMissingFolder: async () => {
        const reservedId = acquired ?? await generateDriveLibraryFolderId(token, signal);
        if (!acquired) {
          await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(ref);
            signal.throwIfAborted();
            if (snapshot.get('lease') !== lease || snapshot.get('leaseUntil') <= Date.now()) {
              throw new DriveLibraryFolderBusyError();
            }
            transaction.update(ref, { reservedId });
          });
        }
        signal.throwIfAborted();
        return createReservedDriveLibraryFolder(token, reservedId, signal);
      },
    });
    if (!folderId) throw new Error('Missing canonical Drive folder');
    return folderId;
  } finally {
    invalidateDriveCache(cacheKey);
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.get('lease') !== lease) return;
      if (snapshot.get('reservedId')) transaction.update(ref, { lease: '', leaseUntil: 0 });
      else transaction.delete(ref);
    }).catch(() => { /* An abandoned lease expires. */ });
  }
}
