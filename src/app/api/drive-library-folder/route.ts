import {
  DRIVE_FOLDER_COORDINATION_UNCONFIGURED,
  getDriveUserPermissionId,
  GoogleDriveFolderConflictError,
  isGoogleDriveAuthError,
  isGoogleDrivePermissionError,
} from '../../../lib/googleDrive';
import {
  DriveLibraryFolderBusyError,
  isDriveFolderCoordinationConfigured,
  isSameDriveRequestOrigin,
  resolveCoordinatedDriveLibraryFolder,
} from '../../../server/driveLibraryFolder';

export const maxDuration = 45;
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' };
const json = (body: object, status = 200) => Response.json(body, { status, headers });

export async function POST(request: Request) {
  if (!isSameDriveRequestOrigin(request)) return json({ error: 'drive-folder-origin' }, 403);
  if (!isDriveFolderCoordinationConfigured()) {
    return json({ error: DRIVE_FOLDER_COORDINATION_UNCONFIGURED }, 501);
  }
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]{10,4096})$/i)?.[1];
  if (!token) return json({ error: 'drive-folder-auth' }, 401);

  try {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const permissionId = await getDriveUserPermissionId(token, signal);
    const folderId = await resolveCoordinatedDriveLibraryFolder(token, permissionId, signal);
    return json({ folderId });
  } catch (error) {
    if (isGoogleDriveAuthError(error)) return json({ error: 'drive-folder-auth' }, 401);
    if (isGoogleDrivePermissionError(error)) return json({ error: 'drive-folder-permission' }, 403);
    if (error instanceof DriveLibraryFolderBusyError) return json({ error: 'drive-folder-busy' }, 409);
    if (error instanceof GoogleDriveFolderConflictError) return json({ error: 'drive-folder-conflict' }, 409);
    return json({ error: 'drive-folder-unavailable' }, 503);
  }
}
