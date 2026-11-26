// src/lib/googleDrive.ts

import type { Book } from '../types';
import {
  getArchiveFormat,
  getReaderFormat,
  getSourceBookFormat,
  getSupportedBookMimeType,
} from './bookFormats.ts';
import {
  DriveUploadHttpError,
  uploadFileResumable,
  type DriveUploadProgress,
} from './driveUpload.ts';

/**
 * 타임아웃 기능이 포함된 fetch 함수
 * 지정된 시간(ms) 안에 응답이 없으면 요청을 취소하고 에러를 발생시킵니다.
 */
const abortError = () => new DOMException('Request aborted', 'AbortError');

export const fetchAndConsumeWithTimeout = async <T>(
  url: string,
  options: RequestInit,
  timeout: number,
  consume: (response: Response) => Promise<T>,
) => {
  const controller = new AbortController();
  const callerSignal = options.signal;
  let didTimeout = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);

  if (callerSignal?.aborted) throw abortError();
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const id = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return await consume(response);
  } catch (error: unknown) {
    if (callerSignal?.aborted) throw abortError();
    if (didTimeout) throw new Error('Network timeout');
    throw error;
  } finally {
    clearTimeout(id);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
};

export const fetchWithTimeout = (
  url: string,
  options: RequestInit = {},
  timeout = 5000,
) => fetchAndConsumeWithTimeout(url, options, timeout, async (response) => response);

export class GoogleDriveAuthError extends Error {
  constructor(message = 'Google Drive authorization expired') {
    super(message);
    this.name = 'GoogleDriveAuthError';
  }
}

export class GoogleDrivePermissionError extends Error {
  constructor(message = 'Google Drive permission denied') {
    super(message);
    this.name = 'GoogleDrivePermissionError';
  }
}

export class GoogleDriveFolderConflictError extends Error {
  constructor(message = "이름이 같은 'web viewer' 폴더가 여러 개입니다.") {
    super(message);
    this.name = 'GoogleDriveFolderConflictError';
  }
}

export const isGoogleDriveAuthError = (error: unknown) => error instanceof GoogleDriveAuthError;
export const isGoogleDrivePermissionError = (error: unknown) => error instanceof GoogleDrivePermissionError;

export const DRIVE_LIBRARY_FOLDER_NAME = 'web viewer';
const DRIVE_LIBRARY_REGISTRY_NAME = 'twreader-library.json';
const MAX_DRIVE_LIST_PAGES = 100;
const libraryFolderCache = new Map<string, string>();
const syncedLibraryRegistry = new Map<string, string>();
const libraryFolderInFlight = new Map<string, {
  createIfMissing: boolean;
  promise: Promise<string | null>;
}>();
const registrySyncInFlight = new Map<string, Promise<void>>();

type DriveFolder = {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
};

const throwIfGoogleDriveAuthError = (response: Response) => {
  if (response.status === 401) {
    throw new GoogleDriveAuthError();
  }
};

const throwIfGoogleDrivePermissionError = (response: Response) => {
  if (response.status === 403) {
    throw new GoogleDrivePermissionError();
  }
};

const readDriveJson = <T>(response: Response, message: string): Promise<T> => {
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error(message);
  }
  return response.json() as Promise<T>;
};

const fetchDriveMetadata = <T>(
  url: string,
  token: string,
  signal: AbortSignal | undefined,
  consume: (response: Response) => Promise<T>,
) => fetchAndConsumeWithTimeout(url, {
  headers: { Authorization: `Bearer ${token}` },
  signal,
}, 5000, consume);

export const getDriveUserPermissionId = async (token: string, signal?: AbortSignal) => {
  const data = await fetchDriveMetadata(
    'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)',
    token, signal,
    (response) => readDriveJson<{ user?: { permissionId?: unknown } }>(response, 'Drive 사용자 식별 정보 조회 실패'),
  );
  const permissionId = data.user?.permissionId;
  if (typeof permissionId !== 'string' || !permissionId.trim()) {
    throw new Error('Drive 사용자 식별 정보가 없습니다.');
  }
  return permissionId.trim();
};

const listDriveFolders = async (query: string, token: string, signal?: AbortSignal) => {
  const files: DriveFolder[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,trashed)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await fetchDriveMetadata(url.toString(), token, signal, (response) =>
      readDriveJson<{ files?: DriveFolder[]; nextPageToken?: string }>(response, '폴더 목록 조회 실패'));
    files.push(...(data.files ?? []));
    if (!data.nextPageToken) return files;
    if (seenTokens.has(data.nextPageToken)) {
      throw new Error('폴더 목록 페이지 토큰이 반복되었습니다.');
    }
    seenTokens.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  throw new Error('폴더 목록 페이지 수가 제한을 초과했습니다.');
};

const rememberLibraryFolderId = (cacheKey: string, folderId: string) => {
  libraryFolderCache.set(cacheKey, folderId);
  return folderId;
};

const fetchDriveFolder = async (folderId: string, token: string, signal?: AbortSignal) => {
  return fetchDriveMetadata(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`,
    token, signal,
    async (response) => response.status === 404 ? null : readDriveJson<DriveFolder>(response, '폴더 정보 조회 실패'),
  );
};

const isUsableLibraryFolder = (folder: DriveFolder | null) => (
  folder?.mimeType === 'application/vnd.google-apps.folder'
  && folder.trashed !== true
  && folder.name === DRIVE_LIBRARY_FOLDER_NAME
);

const readDriveLibraryRegistry = async (token: string, signal?: AbortSignal, requireAccess = false) => {
  const query = `name = '${DRIVE_LIBRARY_REGISTRY_NAME}' and 'appDataFolder' in parents and trashed = false`;
  const files: Array<{ id: string }> = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('spaces', 'appDataFolder');
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('fields', 'nextPageToken,files(id,modifiedTime)');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await fetchDriveMetadata(url.toString(), token, signal, async (response) => {
      if (response.status === 403 && !requireAccess) return null;
      return readDriveJson<{ files?: Array<{ id: string }>; nextPageToken?: string }>(response, '라이브러리 폴더 설정 조회 실패');
    });
    if (!data) return null;
    files.push(...(data.files ?? []));
    if (!data.nextPageToken) break;
    if (seenTokens.has(data.nextPageToken)) {
      throw new Error('라이브러리 설정 페이지 토큰이 반복되었습니다.');
    }
    seenTokens.add(data.nextPageToken);
    pageToken = data.nextPageToken;
    if (page === MAX_DRIVE_LIST_PAGES - 1) {
      throw new Error('라이브러리 설정 페이지 수가 제한을 초과했습니다.');
    }
  }
  if (files.length === 0) return null;

  for (const [index, file] of files.entries()) {
    const config = await fetchDriveMetadata(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
      token, signal,
      async (response) => {
        if (response.status === 404 || (response.status === 403 && !requireAccess)) return null;
        return readDriveJson<{ version?: unknown; folderId?: unknown }>(response, '라이브러리 폴더 설정 다운로드 실패');
      },
    );
    if (!config) continue;
    if (config.version === 1 && typeof config.folderId === 'string') {
      return {
        fileId: file.id,
        folderId: config.folderId,
        duplicateFileIds: files.filter((_, fileIndex) => fileIndex !== index).map(({ id }) => id),
      };
    }
  }

  return {
    fileId: files[0].id,
    folderId: null,
    duplicateFileIds: files.slice(1).map(({ id }) => id),
  };
};

const writeDriveLibraryRegistry = async (
  folderId: string,
  token: string,
  existingFileId?: string,
  signal?: AbortSignal,
) => {
  const content = JSON.stringify({ version: 1, folderId });
  if (existingFileId) {
    const response = await fetchWithTimeout(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingFileId)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: content,
        signal,
      },
      10000,
    );
    if (!response.ok) {
      throwIfGoogleDriveAuthError(response);
      throw new Error('라이브러리 폴더 설정 갱신 실패');
    }
    return;
  }

  const boundary = 'twreader_drive_registry';
  const metadata = JSON.stringify({
    name: DRIVE_LIBRARY_REGISTRY_NAME,
    parents: ['appDataFolder'],
    mimeType: 'application/json',
  });
  const response = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        metadata,
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
        content,
        `\r\n--${boundary}--`,
      ]),
      signal,
    },
    10000,
  );
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throw new Error('라이브러리 폴더 설정 저장 실패');
  }
};

const deleteDuplicateDriveLibraryRegistries = async (
  fileIds: string[],
  token: string,
  signal?: AbortSignal,
) => {
  await Promise.all(fileIds.map(async (fileId) => {
    const response = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        signal,
      },
      10000,
    );
    if (response.status === 404) return;
    if (!response.ok) throwIfGoogleDriveAuthError(response);
  }));
};

const syncDriveLibraryRegistry = async (
  folderId: string,
  token: string,
  cacheKey: string,
  registry?: Awaited<ReturnType<typeof readDriveLibraryRegistry>>,
  signal?: AbortSignal,
) => {
  if (
    syncedLibraryRegistry.get(cacheKey) === folderId
  ) return;
  const syncKey = `${cacheKey}:${folderId}`;
  const currentSync = registrySyncInFlight.get(syncKey);
  if (currentSync) {
    await currentSync;
    return;
  }

  const promise = (async () => {
    try {
      const currentRegistry = registry === undefined
        ? await readDriveLibraryRegistry(token, signal)
        : registry;
      if (currentRegistry?.folderId !== folderId) {
        await writeDriveLibraryRegistry(folderId, token, currentRegistry?.fileId, signal);
      }
      if (currentRegistry?.duplicateFileIds.length) {
        await deleteDuplicateDriveLibraryRegistries(currentRegistry.duplicateFileIds, token, signal);
      }
      syncedLibraryRegistry.set(cacheKey, folderId);
    } catch (error) {
      if (isGoogleDriveAuthError(error) || signal?.aborted) throw error;
      // Existing drive.file-only tokens cannot access appDataFolder. Retry after
      // the next OAuth connection without blocking the current library.
    }
  })();
  registrySyncInFlight.set(syncKey, promise);
  try {
    await promise;
  } finally {
    if (registrySyncInFlight.get(syncKey) === promise) {
      registrySyncInFlight.delete(syncKey);
    }
  }
};

const isDriveId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{5,200}$/.test(value);

export async function generateDriveLibraryFolderId(token: string, signal: AbortSignal) {
  const data = await fetchDriveMetadata(
    'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive',
    token, signal,
    (response) => readDriveJson<{ ids?: unknown[] }>(response, '라이브러리 폴더 ID 예약 실패'),
  );
  const id = data.ids?.[0];
  if (data.ids?.length !== 1 || !isDriveId(id)) throw new Error('잘못된 라이브러리 폴더 ID입니다.');
  return id;
}

const createLibraryFolder = async (token: string, signal?: AbortSignal, reservedId?: string) => {
  const id = await fetchAndConsumeWithTimeout(
    'https://www.googleapis.com/drive/v3/files?fields=id&ignoreDefaultVisibility=true',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(reservedId && { id: reservedId }),
        name: DRIVE_LIBRARY_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
      signal,
    },
    10000,
    async (response) => {
      if (reservedId && response.status === 409) return null;
      const data = await readDriveJson<{ id?: unknown }>(response, '폴더 생성 실패');
      if (!isDriveId(data.id) || (reservedId && data.id !== reservedId)) {
        throw new Error('생성된 라이브러리 폴더 ID를 확인할 수 없습니다.');
      }
      return data.id;
    },
  );
  if (id) return id;

  const existing = await fetchDriveFolder(reservedId!, token, signal);
  if (existing?.id === reservedId && isUsableLibraryFolder(existing)) return reservedId!;
  throw new GoogleDriveFolderConflictError('예약된 라이브러리 폴더를 확인할 수 없습니다. Google Drive에서 폴더 상태를 확인해 주세요.');
};

export async function readReservedDriveLibraryFolder(token: string, id: string, signal: AbortSignal) {
  const existing = await fetchDriveFolder(id, token, signal);
  if (!existing) return null;
  if (existing.id === id && isUsableLibraryFolder(existing)) return id;
  throw new GoogleDriveFolderConflictError('예약된 라이브러리 폴더를 확인할 수 없습니다. Google Drive에서 폴더 상태를 확인해 주세요.');
}

export function createReservedDriveLibraryFolder(token: string, id: string, signal: AbortSignal) {
  return createLibraryFolder(token, signal, id);
}

export const DRIVE_FOLDER_COORDINATION_PATH = '/api/drive-library-folder';
export const DRIVE_FOLDER_COORDINATION_UNCONFIGURED = 'drive-folder-coordination-unconfigured';

async function requestCoordinatedLibraryFolder(token: string, signal?: AbortSignal) {
  return fetchAndConsumeWithTimeout(DRIVE_FOLDER_COORDINATION_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal,
  }, 35_000, async (response) => {
    if (response.status === 501) {
      const data = await response.json() as { error?: unknown };
      if (data.error === DRIVE_FOLDER_COORDINATION_UNCONFIGURED) return null;
    }
    if (response.status === 409) {
      const data = await response.json() as { error?: unknown };
      const message = data.error === 'drive-folder-busy'
        ? '다른 요청이 라이브러리 폴더를 준비 중입니다. 잠시 후 다시 시도해 주세요.'
        : '라이브러리 폴더를 확인할 수 없습니다. Google Drive에서 폴더 상태를 확인해 주세요.';
      throw new GoogleDriveFolderConflictError(message);
    }
    const data = await readDriveJson<{ folderId?: unknown }>(response, '라이브러리 폴더 준비 실패');
    if (!isDriveId(data.folderId)) throw new Error('라이브러리 폴더 ID를 확인할 수 없습니다.');
    return data.folderId;
  });
}

type DriveLibraryFolderOptions = {
  createIfMissing?: boolean;
  signal?: AbortSignal;
  requireRegistryAccess?: boolean;
  createMissingFolder?: () => Promise<string>;
  recoverReservedFolder?: () => Promise<string | null>;
};

const resolveDriveLibraryFolderId = async (
  token: string,
  cacheKey: string,
  { createIfMissing = false, signal, requireRegistryAccess, createMissingFolder, recoverReservedFolder }: DriveLibraryFolderOptions,
): Promise<string | null> => {
  const cachedFolderId = libraryFolderCache.get(cacheKey) ?? null;
  if (cachedFolderId) {
    const cachedFolder = await fetchDriveFolder(cachedFolderId, token, signal);
    if (isUsableLibraryFolder(cachedFolder)) {
      await syncDriveLibraryRegistry(cachedFolderId, token, cacheKey, undefined, signal);
      return cachedFolderId;
    }
    libraryFolderCache.delete(cacheKey);
    syncedLibraryRegistry.delete(cacheKey);
  }

  const registry = await readDriveLibraryRegistry(token, signal, requireRegistryAccess);
  if (registry?.folderId) {
    const registeredFolder = await fetchDriveFolder(registry.folderId, token, signal);
    if (isUsableLibraryFolder(registeredFolder)) {
      if (registry.duplicateFileIds.length) {
        await deleteDuplicateDriveLibraryRegistries(registry.duplicateFileIds, token, signal);
      }
      syncedLibraryRegistry.set(cacheKey, registry.folderId);
      return rememberLibraryFolderId(cacheKey, registry.folderId);
    }
  }

  if (createIfMissing && !createMissingFolder) {
    const coordinatedId = await requestCoordinatedLibraryFolder(token, signal);
    if (coordinatedId) return rememberLibraryFolderId(cacheKey, coordinatedId);

    // Standalone installs share first creation across tabs on this origin.
    const permissionId = await getDriveUserPermissionId(token, signal);
    const createStandalone = (): Promise<string | null> => resolveDriveLibraryFolderId(token, cacheKey, {
      createIfMissing: true, signal,
      createMissingFolder: () => createLibraryFolder(token, signal),
    });
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return navigator.locks.request(`web-reader:drive-folder:${permissionId}`, { signal }, createStandalone);
    }
    return createStandalone();
  }

  const recoveredId = await recoverReservedFolder?.();
  if (recoveredId) {
    await syncDriveLibraryRegistry(recoveredId, token, cacheKey, registry, signal);
    return rememberLibraryFolderId(cacheKey, recoveredId);
  }

  const namedQuery = [
    `name = '${DRIVE_LIBRARY_FOLDER_NAME}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ].join(' and ');
  const namedFolders = await listDriveFolders(namedQuery, token, signal);
  if (namedFolders.length === 1) {
    const folderId = rememberLibraryFolderId(cacheKey, namedFolders[0].id);
    await syncDriveLibraryRegistry(folderId, token, cacheKey, registry, signal);
    return folderId;
  }
  if (namedFolders.length > 1) {
    throw new GoogleDriveFolderConflictError(
      "이름이 같은 'web viewer' 폴더가 여러 개라 라이브러리를 자동 선택하지 않았습니다.",
    );
  }
  if (!createIfMissing || !createMissingFolder) return null;

  const folderId = await createMissingFolder();
  await syncDriveLibraryRegistry(folderId, token, cacheKey, registry, signal);
  return rememberLibraryFolderId(cacheKey, folderId);
};

export const getDriveLibraryFolderId = async (
  token: string,
  options: DriveLibraryFolderOptions & { cacheKey: string },
): Promise<string | null> => {
  const { cacheKey } = options;
  const createIfMissing = options.createIfMissing ?? false;
  const current = libraryFolderInFlight.get(cacheKey);
  if (current) {
    const folderId = await current.promise;
    if (folderId || !createIfMissing || current.createIfMissing) return folderId;
    return getDriveLibraryFolderId(token, {
      ...options,
      createIfMissing: true,
    });
  }

  const promise = resolveDriveLibraryFolderId(token, cacheKey, options);
  libraryFolderInFlight.set(cacheKey, { createIfMissing, promise });
  try {
    return await promise;
  } finally {
    if (libraryFolderInFlight.get(cacheKey)?.promise === promise) {
      libraryFolderInFlight.delete(cacheKey);
    }
  }
};

export const invalidateDriveCache = (cacheKey: string) => {
  libraryFolderCache.delete(cacheKey);
  syncedLibraryRegistry.delete(cacheKey);
  libraryFolderInFlight.delete(cacheKey);
  for (const key of registrySyncInFlight.keys()) {
    if (key.startsWith(`${cacheKey}:`)) registrySyncInFlight.delete(key);
  }
};

export const invalidateDriveCachesForOwner = (ownerKey: string, exceptCacheKey?: string) => {
  const prefix = `${ownerKey}::`;
  const keys = new Set([
    ...libraryFolderCache.keys(),
    ...syncedLibraryRegistry.keys(),
    ...libraryFolderInFlight.keys(),
  ]);
  for (const key of keys) {
    if (key.startsWith(prefix) && key !== exceptCacheKey) invalidateDriveCache(key);
  }
};

export const uploadFile = async (
  fileName: string,
  content: Blob,
  folderId: string,
  token: string,
  mimeType: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DriveUploadProgress) => void;
  } = {},
) => {
  try {
    return await uploadFileResumable({
      file: content,
      fileName,
      folderId,
      token,
      mimeType,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  } catch (error) {
    if (error instanceof DriveUploadHttpError) {
      if (error.status === 401) throw new GoogleDriveAuthError();
      if (error.status === 403) throw new GoogleDrivePermissionError();
      console.error('Google Drive Upload Error:', error.responseText);
      throw new Error('클라우드 업로드 실패');
    }
    throw error;
  }
};

export const normalizeDriveBooks = (files: Book[]) => files.flatMap((file) => {
  const sourceFormat = getSourceBookFormat(file.name, file.mimeType);
  if (!sourceFormat) return [];

  return [{
    ...file,
    mimeType: getSupportedBookMimeType(file.name, file.mimeType),
    sourceFormat,
    readerFormat: getReaderFormat(sourceFormat),
    archiveFormat: getArchiveFormat(sourceFormat),
  }];
});

export const fetchDriveFiles = async (
  token: string,
  folderId: string,
  signal?: AbortSignal,
) => {
  const q = `'${folderId}' in parents and trashed=false`;
  const files: Book[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_DRIVE_LIST_PAGES; page += 1) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)',
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await fetchDriveMetadata(url.toString(), token, signal, (response) =>
      readDriveJson<{ files?: Book[]; nextPageToken?: string }>(response, '파일 목록 조회 실패'));
    files.push(...(data.files ?? []));
    if (!data.nextPageToken) {
      return { files: normalizeDriveBooks(files) };
    }
    if (seenTokens.has(data.nextPageToken)) {
      throw new Error('파일 목록 페이지 토큰이 반복되었습니다.');
    }
    seenTokens.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  throw new Error('파일 목록 페이지 수가 제한을 초과했습니다.');
};

export const fetchFullFile = async (fileId: string, token: string, signal?: AbortSignal) => {
  // [Modified] 파일 다운로드는 대용량(10MB+)을 고려하여 3분(180초) 대기
  return fetchAndConsumeWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
    180000,
    async (response) => {
      if (!response.ok) {
        throwIfGoogleDriveAuthError(response);
        throwIfGoogleDrivePermissionError(response);
        throw new Error('파일 로드 실패');
      }
      return response.arrayBuffer();
    },
  );
};

export const fetchFullFileBlob = async (fileId: string, token: string, signal?: AbortSignal) => {
  return fetchAndConsumeWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    },
    180000,
    async (response) => {
      if (!response.ok) {
        throwIfGoogleDriveAuthError(response);
        throwIfGoogleDrivePermissionError(response);
        throw new Error('파일 로드 실패');
      }
      return response.blob();
    },
  );
};

export const deleteDriveFile = async (fileId: string, token: string) => {
  await fetchAndConsumeWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    10000,
    async (response) => {
      // A previous attempt may have deleted the file before local progress reset.
      if (response.ok || response.status === 404) return;
      throwIfGoogleDriveAuthError(response);
      throwIfGoogleDrivePermissionError(response);
      throw new Error('파일 삭제 실패');
    },
  );
};
