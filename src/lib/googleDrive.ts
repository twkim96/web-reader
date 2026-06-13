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

export const isGoogleDriveAuthError = (error: unknown) => error instanceof GoogleDriveAuthError;
export const isGoogleDrivePermissionError = (error: unknown) => error instanceof GoogleDrivePermissionError;

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

/**
 * 구글 드라이브 내 특정 이름의 폴더 ID를 조회합니다.
 */
export const findFolderId = async (folderName: string, token: string) => {
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000 
  );
  
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    return null;
  }
  const data = await response.json();
  return data.files?.[0]?.id || null;
};

/**
 * 구글 드라이브에 새로운 폴더를 생성합니다.
 */
export const createFolder = async (folderName: string, token: string) => {
  const response = await fetchWithTimeout(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
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

export const fetchDriveFileMetadata = async (fileId: string, token: string) => {
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,md5Checksum`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000,
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throwIfGoogleDriveAuthError(response);
    throwIfGoogleDrivePermissionError(response);
    throw new Error('파일 정보 조회 실패');
  }

  const [book] = normalizeDriveBooks([await response.json() as Book]);
  return book ?? null;
};

export const fetchDriveFiles = async (token: string, folderId?: string, pickedFileIds: string[] = []) => {
  let q = 'trashed=false';
  if (folderId) q = `'${folderId}' in parents and ${q}`;
  
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
  const folderFiles = normalizeDriveBooks(data.files ?? []);
  const pickedResults = await Promise.all(pickedFileIds.map(async (fileId) => {
    try {
      return await fetchDriveFileMetadata(fileId, token);
    } catch (error) {
      if (isGoogleDriveAuthError(error)) throw error;
      console.warn(`Picked Drive file metadata unavailable: ${fileId}`);
      return null;
    }
  }));
  const filesById = new Map(folderFiles.map((file) => [file.id, file]));
  pickedResults.forEach((file) => {
    if (file) filesById.set(file.id, file);
  });

  return { ...data, files: [...filesById.values()] };
};

export const fetchFullFile = async (fileId: string, token: string) => {
  // [Modified] 파일 다운로드는 대용량(10MB+)을 고려하여 3분(180초) 대기
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
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
