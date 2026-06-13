import { forwardRef, useImperativeHandle } from 'react';
import { createFolder, findFolderId, isGoogleDriveAuthError, uploadFile } from '../../lib/googleDrive';
import { saveBookToLocal } from '../../lib/localDB';
import type { Book } from '../../types';
import { ensureEpubBook } from '../../lib/bookContent';
import {
  DEFAULT_MAX_IMPORT_FILES,
  EXTENDED_IMPORT_FORMATS_ENABLED,
  getReaderFormat,
  getSourceBookFormat,
  getSupportedBookMimeType,
  updateImportSelection,
} from '../../lib/bookFormats';

interface FileUploaderProps {
  googleToken: string | null;
  isOfflineMode: boolean;
  onRefresh: () => void;
  onLocalBookImported?: () => void;
  setIsSyncing: (syncing: boolean) => void;
  isCloudTokenValid?: () => boolean;
  onCloudAuthExpired?: () => void;
}

export interface FileUploaderHandle {
  importFiles: (files: FileList | File[]) => Promise<void>;
}

export const FileUploader = forwardRef<FileUploaderHandle, FileUploaderProps>(({
  googleToken,
  isOfflineMode,
  onRefresh,
  onLocalBookImported,
  setIsSyncing,
  isCloudTokenValid,
  onCloudAuthExpired
}, ref) => {
  const syncFileToDrive = async (fileName: string, content: ArrayBuffer, mimeType: string) => {
    if (!googleToken || isOfflineMode) return null;

    try {
      setIsSyncing(true);
      const targetFolderName = "web viewer";
      
      let folderId = await findFolderId(targetFolderName, googleToken);
      if (!folderId) {
        folderId = await createFolder(targetFolderName, googleToken);
      }

      if (folderId) {
        const result = await uploadFile(fileName, content, folderId, googleToken, mimeType);
        onRefresh(); // 목록 갱신
        return result.id as string; // 구글 드라이브 ID 반환
      } else {
        throw new Error('폴더를 생성하거나 찾을 수 없습니다.');
      }
    } catch (error) {
      if (isGoogleDriveAuthError(error)) {
        onCloudAuthExpired?.();
        return null;
      }

      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      console.error('Sync failed:', error);
      alert(`클라우드 동기화 실패: ${message}\n(파일은 기기에 로컬로 저장되었습니다.)`);
      return null;
    } finally {
      setIsSyncing(false);
    }
  };

  const importFile = (file: File) => new Promise<void>((resolve) => {
    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as ArrayBuffer | undefined;
      if (!content) {
        resolve();
        return;
      }

      const originalMimeType = getSupportedBookMimeType(file.name, file.type);
      const sourceFormat = getSourceBookFormat(file.name, originalMimeType);

      let bookId = file.name; // 기본값은 파일명
      
      // 1. 구글 드라이브 동기화 (원본 txt/epub 그대로 업로드)
      if (!isOfflineMode && googleToken) {
        if (isCloudTokenValid?.() === false) {
          onCloudAuthExpired?.();
        } else {
          const driveId = await syncFileToDrive(file.name, content, originalMimeType);
          if (driveId) {
            bookId = driveId; // 드라이브 업로드 성공 시 해당 ID 사용
          }
        }
      } else if (!isOfflineMode && !googleToken) {
        onCloudAuthExpired?.();
      }

      // 2. 로컬 저장 (확보된 bookId 사용 - 중복 방지 핵심)
      const book: Book = {
        id: bookId,
        name: file.name,
        mimeType: originalMimeType,
        sourceFormat: sourceFormat ?? undefined,
        readerFormat: sourceFormat ? getReaderFormat(sourceFormat) : undefined,
      };
      
      try {
        const epub = await ensureEpubBook(book, content);
        await saveBookToLocal(epub.book, epub.content);
      } catch (err) {
        console.error('epub 변환/저장 실패:', err);
        alert(`${file.name} 도서를 EPUB으로 준비하는 데 실패했습니다.`);
        resolve();
        return;
      }
      
      if (onLocalBookImported) {
        onLocalBookImported();
      }
      resolve();
    };
    reader.onerror = () => {
      alert(`${file.name} 파일을 읽지 못했습니다.`);
      resolve();
    };
    reader.readAsArrayBuffer(file);
  });

  const importFiles = async (files: FileList | File[]) => {
    const result = updateImportSelection([], Array.from(files), {
      allowExtendedFormats: EXTENDED_IMPORT_FORMATS_ENABLED,
      maxFiles: DEFAULT_MAX_IMPORT_FILES,
    });

    if (result.error) {
      alert(result.error);
      return;
    }

    for (const file of result.files) {
      await importFile(file);
    }
  };

  useImperativeHandle(ref, () => ({
    importFiles,
  }));

  return null;
});

FileUploader.displayName = 'FileUploader';
