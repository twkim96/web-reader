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
const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeout = 5000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Network timeout');
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
};

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
const DRIVE_LIBRARY_FOLDER_ID_KEY = 'google_drive_library_folder_id';
const DRIVE_LIBRARY_REGISTRY_SYNCED_KEY = 'google_drive_library_registry_synced';
const DRIVE_LIBRARY_REGISTRY_NAME = 'twreader-library.json';
let registrySyncInFlight: { folderId: string; promise: Promise<void> } | null = null;

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

const listDriveFolders = async (query: string, token: string) => {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=drive&pageSize=100&fields=files(id,name,mimeType,trashed)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000,
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('폴더 목록 조회 실패');
  }

  const data = await response.json() as { files?: DriveFolder[] };
  return data.files ?? [];
};

const getStoredLibraryFolderId = () => {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(DRIVE_LIBRARY_FOLDER_ID_KEY);
};

const rememberLibraryFolderId = (folderId: string) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(DRIVE_LIBRARY_FOLDER_ID_KEY, folderId);
  }
  return folderId;
};

const forgetLibraryFolderId = () => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(DRIVE_LIBRARY_FOLDER_ID_KEY);
  }
};

const fetchDriveFolder = async (folderId: string, token: string) => {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('폴더 정보 조회 실패');
  }

  return await response.json() as DriveFolder;
};

const isUsableLibraryFolder = (folder: DriveFolder | null) => (
  folder?.mimeType === 'application/vnd.google-apps.folder'
  && folder.trashed !== true
  && folder.name === DRIVE_LIBRARY_FOLDER_NAME
);

const readDriveLibraryRegistry = async (token: string) => {
  const query = `name = '${DRIVE_LIBRARY_REGISTRY_NAME}' and 'appDataFolder' in parents and trashed = false`;
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&spaces=appDataFolder&orderBy=modifiedTime%20desc&pageSize=100&fields=files(id,modifiedTime)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000,
  );

  if (response.status === 403) return null;
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throw new Error('라이브러리 폴더 설정 조회 실패');
  }

  const files = (await response.json() as { files?: Array<{ id: string }> }).files ?? [];
  if (files.length === 0) return null;

  for (const [index, file] of files.entries()) {
    const contentResponse = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
      5000,
    );
    if (contentResponse.status === 403 || contentResponse.status === 404) continue;
    if (!contentResponse.ok) {
      throwIfGoogleDriveAuthError(contentResponse);
      throw new Error('라이브러리 폴더 설정 다운로드 실패');
    }

    const config = await contentResponse.json() as { version?: unknown; folderId?: unknown };
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
    },
    10000,
  );
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throw new Error('라이브러리 폴더 설정 저장 실패');
  }
};

const hasSyncedLibraryRegistry = (folderId: string) => (
  typeof window !== 'undefined'
  && localStorage.getItem(DRIVE_LIBRARY_REGISTRY_SYNCED_KEY) === folderId
);

const rememberSyncedLibraryRegistry = (folderId: string) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(DRIVE_LIBRARY_REGISTRY_SYNCED_KEY, folderId);
  }
};

const deleteDuplicateDriveLibraryRegistries = async (fileIds: string[], token: string) => {
  await Promise.all(fileIds.map(async (fileId) => {
    const response = await fetchWithTimeout(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
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
  registry?: Awaited<ReturnType<typeof readDriveLibraryRegistry>>,
) => {
  if (hasSyncedLibraryRegistry(folderId)) return;
  if (registrySyncInFlight?.folderId === folderId) {
    await registrySyncInFlight.promise;
    return;
  }

  const promise = (async () => {
    try {
      const currentRegistry = registry === undefined
        ? await readDriveLibraryRegistry(token)
        : registry;
      if (currentRegistry?.folderId !== folderId) {
        await writeDriveLibraryRegistry(folderId, token, currentRegistry?.fileId);
      }
      if (currentRegistry?.duplicateFileIds.length) {
        await deleteDuplicateDriveLibraryRegistries(currentRegistry.duplicateFileIds, token);
      }
      rememberSyncedLibraryRegistry(folderId);
    } catch (error) {
      if (isGoogleDriveAuthError(error)) throw error;
      // Existing drive.file-only tokens cannot access appDataFolder. Retry after
      // the next OAuth connection without blocking the current library.
    }
  })();
  registrySyncInFlight = { folderId, promise };
  try {
    await promise;
  } finally {
    if (registrySyncInFlight?.promise === promise) registrySyncInFlight = null;
  }
};

const createLibraryFolder = async (token: string) => {
  const response = await fetchWithTimeout(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: DRIVE_LIBRARY_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    10000
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('폴더 생성 실패');
  }
  const data = await response.json();
  return data.id;
};

export const getDriveLibraryFolderId = async (
  token: string,
  { createIfMissing = false }: { createIfMissing?: boolean } = {},
) => {
  const storedFolderId = getStoredLibraryFolderId();
  if (storedFolderId) {
    const storedFolder = await fetchDriveFolder(storedFolderId, token);
    if (isUsableLibraryFolder(storedFolder)) {
      await syncDriveLibraryRegistry(storedFolderId, token);
      return storedFolderId;
    }
    forgetLibraryFolderId();
  }

  const registry = await readDriveLibraryRegistry(token);
  if (registry?.folderId) {
    const registeredFolder = await fetchDriveFolder(registry.folderId, token);
    if (isUsableLibraryFolder(registeredFolder)) {
      if (registry.duplicateFileIds.length) {
        await deleteDuplicateDriveLibraryRegistries(registry.duplicateFileIds, token);
      }
      rememberSyncedLibraryRegistry(registry.folderId);
      return rememberLibraryFolderId(registry.folderId);
    }
  }

  const namedQuery = [
    `name = '${DRIVE_LIBRARY_FOLDER_NAME}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
  ].join(' and ');
  const namedFolders = await listDriveFolders(namedQuery, token);
  if (namedFolders.length === 1) {
    const folderId = rememberLibraryFolderId(namedFolders[0].id);
    await syncDriveLibraryRegistry(folderId, token, registry);
    return folderId;
  }
  if (namedFolders.length > 1) {
    throw new GoogleDriveFolderConflictError(
      "이름이 같은 'web viewer' 폴더가 여러 개라 라이브러리를 자동 선택하지 않았습니다.",
    );
  }
  if (!createIfMissing) return null;

  const folderId = rememberLibraryFolderId(await createLibraryFolder(token));
  await syncDriveLibraryRegistry(folderId, token, registry);
  return folderId;
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

export const fetchDriveFiles = async (token: string, folderId: string) => {
  const q = `'${folderId}' in parents and trashed=false`;

  // 파일 목록 조회도 5초 타임아웃 (오프라인 감지용)
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime,md5Checksum)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('파일 목록 조회 실패');
  }
  
  const data = await response.json() as { files?: Book[] };
  return { ...data, files: normalizeDriveBooks(data.files ?? []) };
};

export const fetchFullFile = async (fileId: string, token: string) => {
  // [Modified] 파일 다운로드는 대용량(10MB+)을 고려하여 3분(180초) 대기
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
    180000 
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('파일 로드 실패');
  }
  
  return await response.arrayBuffer();
};

export const fetchFullFileBlob = async (fileId: string, token: string) => {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
    180000,
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('파일 로드 실패');
  }

  return response.blob();
};

export const deleteDriveFile = async (fileId: string, token: string) => {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    },
    10000
  );

  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    if (response.status === 403) {
      const errorText = await response.text();
      console.warn('Google Drive Delete Permission Error:', errorText);
      throw new GoogleDrivePermissionError('클라우드 도서 삭제 권한이 없습니다.');
    }
    throw new Error('클라우드 도서 삭제 실패');
  }
};
