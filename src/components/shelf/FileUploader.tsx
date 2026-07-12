import { forwardRef, useImperativeHandle, useRef } from 'react';
import { getDriveLibraryFolderId, isGoogleDriveAuthError, uploadFile } from '../../lib/googleDrive';
import {
  saveArchiveInspectionToLocalV5,
  saveBookToLocalV5,
} from '../../lib/localDBV5';
import { LocalStorageCapacityError } from '../../lib/localDB';
import { ownerRuntime, type OwnerSnapshot } from '../../lib/ownerRuntime';
import type { Book } from '../../types';
import { ensureEpubBook } from '../../lib/bookContent';
import { getBookFingerprint } from '../../lib/bookFingerprint';
import type { ArchiveImageIndex } from '../../lib/archiveImageBook';
import {
  ACTIVE_SOURCE_FORMATS,
  DEFAULT_MAX_IMPORT_FILES,
  EXTENDED_IMPORT_FORMATS_ENABLED,
  getArchiveFormat,
  getReaderFormat,
  getSourceBookFormat,
  getSupportedBookMimeType,
  isArchiveFormat,
  updateImportSelection,
} from '../../lib/bookFormats';
import { runSequentialBatch } from '../../lib/sequentialBatch';

interface FileUploaderProps {
  googleToken: string | null;
  isOfflineMode: boolean;
  onRefresh: () => void;
  onLocalBookImported?: () => void;
  setSyncStatus: (status: CloudSyncStatus) => void;
  isCloudTokenValid?: () => boolean;
  onCloudAuthExpired?: () => void;
}

export type CloudSyncStatus = {
  fileName: string;
  progressPercent: number;
  retryCount: number;
} | null;

export interface FileUploaderHandle {
  importFiles: (files: FileList | File[]) => Promise<void>;
  cancelUpload: () => void;
}

export const FileUploader = forwardRef<FileUploaderHandle, FileUploaderProps>(({
  googleToken,
  isOfflineMode,
  onRefresh,
  onLocalBookImported,
  setSyncStatus,
  isCloudTokenValid,
  onCloudAuthExpired
}, ref) => {
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadGenerationRef = useRef(0);
  const activeSyncRef = useRef<{ generation: number; sequence: number } | null>(null);
  const syncSequenceRef = useRef(0);

  const syncFileToDrive = async (
    file: File,
    mimeType: string,
    signal: AbortSignal,
    generation: number,
  ) => {
    if (!googleToken || isOfflineMode) {
      return { book: null, stopBatch: false };
    }
    if (signal.aborted || uploadGenerationRef.current !== generation) {
      return { book: null, stopBatch: true };
    }

    const sequence = ++syncSequenceRef.current;
    activeSyncRef.current = { generation, sequence };
    const setCurrentSyncStatus = (status: CloudSyncStatus) => {
      if (
        signal.aborted
        || uploadGenerationRef.current !== generation
        || activeSyncRef.current?.generation !== generation
        || activeSyncRef.current.sequence !== sequence
      ) return;
      setSyncStatus(status);
    };
    try {
      setCurrentSyncStatus({ fileName: file.name, progressPercent: 0, retryCount: 0 });
      const folderId = await getDriveLibraryFolderId(googleToken, { createIfMissing: true });
      if (signal.aborted || uploadGenerationRef.current !== generation) {
        return { book: null, stopBatch: true };
      }

      if (folderId) {
        const result = await uploadFile(file.name, file, folderId, googleToken, mimeType, {
          signal,
          onProgress: ({ uploadedBytes, totalBytes, retryCount }) => {
            const progressPercent = totalBytes === 0
              ? 100
              : Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
            setCurrentSyncStatus({ fileName: file.name, progressPercent, retryCount });
          },
        });
        return { book: result, stopBatch: false };
      } else {
        throw new Error('폴더를 생성하거나 찾을 수 없습니다.');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { book: null, stopBatch: true };
      }
      if (isGoogleDriveAuthError(error)) {
        onCloudAuthExpired?.();
        return { book: null, stopBatch: true };
      }

      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      console.error('Sync failed:', error);
      alert(`클라우드 동기화 실패: ${message}\n로컬 저장을 계속합니다.`);
      return { book: null, stopBatch: false };
    } finally {
      if (
        activeSyncRef.current?.generation === generation
        && activeSyncRef.current.sequence === sequence
      ) {
        if (uploadGenerationRef.current === generation) setSyncStatus(null);
        activeSyncRef.current = null;
      }
    }
  };

  const importFile = async (
    file: File,
    signal: AbortSignal,
    generation: number,
    owner: OwnerSnapshot,
  ) => {
    const originalMimeType = getSupportedBookMimeType(file.name, file.type);
    const sourceFormat = getSourceBookFormat(file.name, originalMimeType);
    if (!sourceFormat) return { refresh: false, stop: false };

    let archiveImageIndex: ArchiveImageIndex | undefined;
    if (isArchiveFormat(sourceFormat)) {
      try {
        if (sourceFormat === '7z') {
          const { inspectSevenZipImageArchive } = await import('../../lib/sevenZipImages');
          archiveImageIndex = (await inspectSevenZipImageArchive(file)).index;
        } else {
          const { inspectZipImageArchive } = await import('../../lib/archiveImages');
          archiveImageIndex = (await inspectZipImageArchive(file)).index;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '압축 파일을 확인하지 못했습니다.';
        alert(`${file.name}\n${message}`);
        return { refresh: false, stop: false };
      }
    }
    if (
      signal.aborted
      || uploadGenerationRef.current !== generation
      || !ownerRuntime.isCurrent(owner)
    ) {
      return { refresh: false, stop: true };
    }

    let driveBook: Awaited<ReturnType<typeof uploadFile>> | null = null;
    let stopBatch = false;

    // 1. 구글 드라이브에 원본 파일 업로드
    if (!isOfflineMode && googleToken) {
      if (isCloudTokenValid?.() === false) {
        onCloudAuthExpired?.();
        stopBatch = true;
      } else {
        const syncResult = await syncFileToDrive(
          file,
          originalMimeType,
          signal,
          generation,
        );
        driveBook = syncResult.book;
        stopBatch = syncResult.stopBatch;
      }
    } else if (!isOfflineMode && !googleToken) {
      onCloudAuthExpired?.();
      stopBatch = true;
    }
    if (signal.aborted) return { refresh: Boolean(driveBook), stop: true };

    // 2. 로컬 저장. 압축 원본은 Blob으로 유지하고 텍스트 도서만 변환한다.
    const book: Book = {
      id: driveBook?.id ?? file.name,
      name: driveBook?.name ?? file.name,
      mimeType: driveBook?.mimeType ?? originalMimeType,
      size: driveBook?.size ?? file.size,
      source: driveBook ? 'cloud' : 'local',
      sourceFormat,
      readerFormat: getReaderFormat(sourceFormat),
      archiveFormat: getArchiveFormat(sourceFormat),
      modifiedTime: driveBook?.modifiedTime
        ?? (file.lastModified ? new Date(file.lastModified).toISOString() : undefined),
      md5Checksum: driveBook?.md5Checksum,
    };

    let savedLocally = false;
    try {
      if (isArchiveFormat(sourceFormat) || sourceFormat === 'pdf') {
        await saveBookToLocalV5(owner.ownerKey, book, file);
      } else {
        const content = await file.arrayBuffer();
        const epub = await ensureEpubBook(book, content);
        await saveBookToLocalV5(owner.ownerKey, epub.book, epub.content);
      }
      savedLocally = true;
    } catch (err) {
      console.error('도서 준비/저장 실패:', err);
      if (driveBook) {
        alert(err instanceof LocalStorageCapacityError
          ? `${err.message}\n클라우드에는 업로드되었으며 온라인에서 읽을 수 있습니다.`
          : '로컬 저장에 실패했지만 클라우드에는 업로드되었습니다.');
      } else {
        alert(err instanceof LocalStorageCapacityError
          ? err.message
          : `${file.name} 도서를 준비하거나 저장하는 데 실패했습니다.`);
      }
    }

    if (archiveImageIndex && (savedLocally || driveBook)) {
      const fingerprint = getBookFingerprint(book);
      if (fingerprint) {
        try {
          await saveArchiveInspectionToLocalV5(
            owner.ownerKey,
            book.id,
            fingerprint,
            archiveImageIndex,
          );
        } catch (error) {
          console.warn('[Import] Failed to cache archive index:', error);
        }
      }
    }

    if (savedLocally) onLocalBookImported?.();
    return { refresh: Boolean(driveBook), stop: stopBatch };
  };

  const importFiles = async (files: FileList | File[]) => {
    const owner = ownerRuntime.capture();
    if (!owner) return;
    if (owner.storageMode === 'legacy-readonly') {
      alert('읽기 전용 복구 모드에서는 도서를 추가할 수 없습니다.');
      return;
    }
    const result = updateImportSelection([], Array.from(files), {
      allowExtendedFormats: EXTENDED_IMPORT_FORMATS_ENABLED,
      enabledFormats: ACTIVE_SOURCE_FORMATS,
      maxFiles: DEFAULT_MAX_IMPORT_FILES,
    });

    if (result.error) {
      alert(result.error);
      return;
    }

    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const generation = ++uploadGenerationRef.current;

    try {
      await runSequentialBatch(
        result.files,
        controller.signal,
        (file) => importFile(file, controller.signal, generation, owner),
        onRefresh,
      );
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        activeSyncRef.current = null;
        setSyncStatus(null);
      }
    }
  };

  useImperativeHandle(ref, () => ({
    importFiles,
    cancelUpload: () => {
      uploadAbortRef.current?.abort();
      uploadGenerationRef.current += 1;
      activeSyncRef.current = null;
      setSyncStatus(null);
    },
  }));

  return null;
});

FileUploader.displayName = 'FileUploader';
