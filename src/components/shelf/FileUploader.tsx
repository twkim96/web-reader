import React from 'react';
import { findFolderId, createFolder, uploadFile } from '../../lib/googleDrive';
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
}

export const FileUploader: React.FC<FileUploaderProps> = ({
  googleToken,
  isOfflineMode,
  onRefresh,
  onLocalBookImported,
  fileInputRef,
  setIsSyncing
}) => {
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
        console.log('Google Drive sync successful, ID:', result.id);
        onRefresh(); // 목록 갱신
        return result.id as string; // 구글 드라이브 ID 반환
      } else {
        throw new Error('폴더를 생성하거나 찾을 수 없습니다.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '알 수 없는 오류';
      console.error('Sync failed:', error);
      alert(`클라우드 동기화 실패: ${message}\n(파일은 기기에 로컬로 저장되었습니다.)`);
      return null;
    } finally {
      setIsSyncing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    const reader = new FileReader();
    reader.onload = async (event) => {
      const content = event.target?.result as ArrayBuffer;
      if (!content) return;

      const originalMimeType = getSupportedBookMimeType(file.name, file.type);

      let bookId = file.name; // 기본값은 파일명
      
      // 1. 구글 드라이브 동기화 (원본 txt/epub 그대로 업로드)
      if (!isOfflineMode && googleToken) {
        const driveId = await syncFileToDrive(file.name, content, originalMimeType);
        if (driveId) {
          bookId = driveId; // 드라이브 업로드 성공 시 해당 ID 사용
        }
      } else if (!isOfflineMode && !googleToken) {
        alert('구글 드라이브 권한이 없습니다. 로그아웃 후 다시 로그인하여 권한을 허용해 주세요.');
        return;
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
        alert('도서를 EPUB으로 준비하는 데 실패했습니다.');
        return;
      }
      
      if (onLocalBookImported) {
        onLocalBookImported();
      }
    };
    reader.readAsArrayBuffer(file);
  };

  return (
    <input 
      type="file" 
      accept=".txt,.epub" 
      ref={fileInputRef} 
      style={{ display: 'none' }} 
      onChange={handleFileUpload} 
    />
  );
};
