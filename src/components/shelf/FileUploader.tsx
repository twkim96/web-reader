import React, { forwardRef, useImperativeHandle } from 'react';
import { createFolder, findFolderId, isGoogleDriveAuthError, uploadFile } from '../../lib/googleDrive';
import { saveBookToLocal } from '../../lib/localDB';
import { Book } from '../../types';
import { ensureEpubBook, getSupportedBookMimeType } from '../../lib/bookContent';

interface FileUploaderProps {
  googleToken: string | null;
  isOfflineMode: boolean;
  onRefresh: () => void;
  onLocalBookImported?: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  setIsSyncing: (syncing: boolean) => void;
  isCloudTokenValid?: () => boolean;
  onCloudAuthExpired?: () => void;
}

export interface FileUploaderHandle {
  importFiles: (files: FileList | File[]) => void;
  openPicker: () => void;
}

const MAX_IMPORT_FILES = 10;

export const FileUploader = forwardRef<FileUploaderHandle, FileUploaderProps>(({
  googleToken,
  isOfflineMode,
  onRefresh,
  onLocalBookImported,
  fileInputRef,
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
    const selectedFiles = Array.from(files).filter((file) => {
      const lowerName = file.name.toLowerCase();
      return lowerName.endsWith('.txt') || lowerName.endsWith('.epub');
    });

    if (selectedFiles.length === 0) {
      alert('지원하는 도서 파일(.txt, .epub)을 선택해 주세요.');
      return;
    }

    if (selectedFiles.length > MAX_IMPORT_FILES) {
      alert(`도서는 한 번에 최대 ${MAX_IMPORT_FILES}개까지 추가할 수 있습니다.`);
      return;
    }

    for (const file of selectedFiles) {
      await importFile(file);
    }
  };

  useImperativeHandle(ref, () => ({
    importFiles,
    openPicker: () => fileInputRef.current?.click(),
  }));

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    void importFiles(files);
    e.target.value = '';
  };

  return (
    <input 
      type="file" 
      accept=".txt,.epub" 
      multiple
      ref={fileInputRef} 
      style={{ display: 'none' }} 
      onChange={handleFileUpload} 
    />
  );
});

FileUploader.displayName = 'FileUploader';
