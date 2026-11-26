import 'server-only';

import { getBookMaxBytes, getSourceBookFormat } from '../../lib/bookFormats';
import { DRIVE_LIBRARY_FOLDER_NAME, fetchAndConsumeWithTimeout, getDriveLibraryFolderId, invalidateDriveCache } from '../../lib/googleDrive';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SOURCE_FIELDS = 'id,name,mimeType,size,parents,trashed,capabilities(canCopy)';
const FOLDER_FIELDS = 'mimeType,parents,trashed,capabilities(canListChildren)';
const MAX_ANCESTRY_DEPTH = 32;
const MAX_SEARCH_PAGES = 3;
const MAX_SEARCH_LOOKUPS = 48;
const MAX_RESULTS = 30;
export const COPY_LIMIT = 8;
const accessDeniedReasons = new Set(['appNotAuthorizedToFile', 'forbidden', 'insufficientFilePermissions', 'domainPolicy']);
const quotaReasons = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);
const driveErrorReasons = new Set([...accessDeniedReasons, ...quotaReasons, 'badRequest', 'insufficientPermissions', 'accessNotConfigured']);

type DriveFile = {
  id?: string;
  name?: string;
  size?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  ownedByMe?: boolean;
  shared?: boolean;
  capabilities?: { canListChildren?: boolean; canAddChildren?: boolean; canCopy?: boolean };
};

export class SharedDriveError extends Error {
  constructor(readonly status: number, readonly reason?: string) {
    super('Shared Drive request failed');
  }
}

export const isDriveId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(value);

function driveJson<T>(token: string, path: string, params: Record<string, string>, signal: AbortSignal, body?: object) {
  const endpoint = new URL(`${API}${path}`);
  endpoint.search = new URLSearchParams(params).toString();
  return fetchAndConsumeWithTimeout(endpoint.toString(), {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
    redirect: 'error',
  }, 6_000, async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { errors?: { reason?: string }[] } } | null;
      const reasons = payload?.error?.errors?.map(({ reason }) => reason ?? '') ?? [];
      const quota = reasons.find((reason) => quotaReasons.has(reason));
      const reason = quota ?? reasons.find((reason) => driveErrorReasons.has(reason));
      const status = quota ? 429 : [400, 401, 403, 404, 409, 429].includes(response.status) ? response.status : 503;
      throw new SharedDriveError(status, reason);
    }
    return await response.json() as T;
  });
}

const getFile = (token: string, id: string, fields: string, signal: AbortSignal) =>
  driveJson<DriveFile>(token, `/files/${encodeURIComponent(id)}`, { fields, supportsAllDrives: 'true' }, signal);

const isMissing = (error: unknown) => error instanceof SharedDriveError && (
  error.status === 404 || (error.status === 403 && !!error.reason && accessDeniedReasons.has(error.reason))
);

export async function canReadSharedFolder(token: string, folderId: string, signal: AbortSignal) {
  try {
    const folder = await getFile(token, folderId, FOLDER_FIELDS, signal);
    return folder.mimeType === FOLDER_MIME && folder.trashed === false && folder.capabilities?.canListChildren === true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function bookFile(file: DriveFile) {
  if (!isDriveId(file.id) || typeof file.name !== 'string' || file.name.length > 500 || file.trashed !== false
    || typeof file.mimeType !== 'string' || file.mimeType.startsWith('application/vnd.google-apps.')
    || file.capabilities?.canCopy !== true) return null;
  const format = getSourceBookFormat(file.name, file.mimeType);
  const size = Number(file.size);
  if (!format || !Number.isSafeInteger(size) || size <= 0 || size > getBookMaxBytes(format)) return null;
  return { id: file.id };
}

function folderMembership(token: string, rootId: string, signal: AbortSignal, budget: number) {
  const folders = new Map<string, Promise<DriveFile | null>>();
  let reachedLimit = false;
  const readParent = (id: string) => {
    let pending = folders.get(id);
    if (pending) return pending;
    if (folders.size >= budget) {
      reachedLimit = true;
      return Promise.resolve(null);
    }
    pending = getFile(token, id, FOLDER_FIELDS, signal).catch((error: unknown) => {
      if (isMissing(error)) return null;
      throw error;
    });
    folders.set(id, pending);
    return pending;
  };
  return {
    async contains(file: DriveFile) {
      const visited = new Set<string>();
      let node = file;
      for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
        // Drive v3 supports exactly one parent per file. Reject ambiguous or cyclic paths.
        const parentId = node.parents?.[0];
        if (node.parents?.length !== 1 || !isDriveId(parentId) || visited.has(parentId)) return false;
        if (parentId === rootId) return true;
        visited.add(parentId);
        const parent = await readParent(parentId);
        if (!parent || parent.mimeType !== FOLDER_MIME || parent.trashed !== false) return false;
        node = parent;
      }
      reachedLimit = true;
      return false;
    },
    get reachedLimit() { return reachedLimit; },
  };
}

const escapeDriveQuery = (value: string) => value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
const normalizeTitle = (value: string) => value.normalize('NFKC').toLowerCase();

export async function searchSharedFolder(token: string, rootId: string, title: string, signal: AbortSignal) {
  const membership = folderMembership(token, rootId, signal, MAX_SEARCH_LOOKUPS);
  const term = escapeDriveQuery(title);
  const phrase = escapeDriveQuery(title.replaceAll('"', ''));
  const query = `trashed = false and (name contains '${term}' or fullText contains '"${phrase}"')`;
  const normalized = normalizeTitle(title);
  const ids = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const result: { files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean } =
      await driveJson(token, '/files', {
        q: query, pageSize: '50',
        fields: `nextPageToken,incompleteSearch,files(${SOURCE_FIELDS})`,
        ...(pageToken && { pageToken }),
      }, signal);
    const candidates = (result.files ?? []).filter((file) =>
      bookFile(file) && normalizeTitle(file.name!).includes(normalized));
    for (let start = 0; start < candidates.length; start += 8) {
      const matches = await Promise.all(candidates.slice(start, start + 8).map(async (file) =>
        await membership.contains(file) ? file.id! : null));
      for (const id of matches) {
        if (id) ids.add(id);
        if (ids.size >= MAX_RESULTS) return { ids: [...ids], limited: true };
      }
    }
    if (membership.reachedLimit || result.incompleteSearch) return { ids: [...ids], limited: true };
    if (!result.nextPageToken) return { ids: [...ids], limited: false };
    if (result.nextPageToken === pageToken) break;
    pageToken = result.nextPageToken;
  }
  return { ids: [...ids], limited: true };
}

export async function getSharedDriveDestination(token: string, permissionId: string, sourceId: string, signal: AbortSignal) {
  const cacheKey = `shared-import:${permissionId}`;
  invalidateDriveCache(cacheKey);
  const id = await getDriveLibraryFolderId(token, { cacheKey, createIfMissing: true, requireRegistryAccess: true, signal });
  if (!isDriveId(id) || id === sourceId) throw new SharedDriveError(403);
  const destination = await getFile(token, id, 'name,mimeType,trashed,ownedByMe,shared,capabilities(canAddChildren)', signal);
  if (destination.name !== DRIVE_LIBRARY_FOLDER_NAME || destination.mimeType !== FOLDER_MIME || destination.trashed !== false
    || destination.ownedByMe !== true || destination.shared !== false
    || destination.capabilities?.canAddChildren !== true) throw new SharedDriveError(403);
  return id;
}

export async function generateCopyIds(token: string, count: number, signal: AbortSignal) {
  const { ids } = await driveJson<{ ids?: string[] }>(token, '/files/generateIds', {
    count: String(count), space: 'drive',
  }, signal);
  if (!ids || ids.length !== count || !ids.every(isDriveId) || new Set(ids).size !== count) throw new SharedDriveError(503);
  return ids;
}

export async function copySharedFiles(
  token: string, rootId: string, ids: string[], permissionId: string, signal: AbortSignal,
  reserveCopyIds: (destination: string, sources: string[]) => Promise<Map<string, string>>,
) {
  const membership = folderMembership(token, rootId, signal, COPY_LIMIT * MAX_ANCESTRY_DEPTH);
  const sources = await Promise.all(ids.map(async (id) => {
    try {
      const file = await getFile(token, id, SOURCE_FIELDS, signal);
      return file.id === id && bookFile(file) && await membership.contains(file);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }));
  if (!sources.some(Boolean)) return ids.map(() => false);
  const destination = await getSharedDriveDestination(token, permissionId, rootId, signal);
  const copyIds = await reserveCopyIds(destination, ids.filter((_, index) => sources[index]));
  signal.throwIfAborted();
  return Promise.all(ids.map(async (id, index) => {
    if (!sources[index]) return false;
    const copyId = copyIds.get(id);
    if (!copyId) return false;
    try {
      const result = await driveJson<DriveFile>(token, `/files/${encodeURIComponent(id)}/copy`, {
        supportsAllDrives: 'true', ignoreDefaultVisibility: 'true', fields: 'id',
      }, signal, { id: copyId, parents: [destination] });
      return result.id === copyId;
    } catch (error) {
      if (!(error instanceof SharedDriveError) || error.status !== 409) return false;
      // A previous request may have copied the file before its response timed out.
      try {
        const existing = await getFile(token, copyId, 'id,parents,trashed,ownedByMe,shared', signal);
        return existing.id === copyId && existing.trashed === false && existing.ownedByMe === true
          && existing.shared === false && existing.parents?.length === 1 && existing.parents[0] === destination;
      } catch {
        return false;
      }
    }
  }));
}
