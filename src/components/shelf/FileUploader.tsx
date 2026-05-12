import React from 'react';
import { findFolderId, createFolder, uploadFile } from '../../lib/googleDrive';
import { saveBookToLocal } from '../../lib/localDB';
import { Book } from '../../types';
import { convertTxtToEpub } from '../../lib/txtToEpub';

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
  const syncFileToDrive = async (fileName: string, content: ArrayBuffer) => {
    if (!googleToken || isOfflineMode) return null;

    try {
      setIsSyncing(true);
      const targetFolderName = "web viewer";
      
      let folderId = await findFolderId(targetFolderName, googleToken);
      if (!folderId) {
        folderId = await createFolder(targetFolderName, googleToken);
      }

      if (folderId) {
        const result = await uploadFile(fileName, content, folderId, googleToken);
        console.log('Google Drive sync successful, ID:', result.id);
        onRefresh(); // 목록 갱신
        return result.id as string; // 구글 드라이브 ID 반환
      } else {
        throw new Error('폴더를 생성하거나 찾을 수 없습니다.');
      }
    } catch (error: any) {
      console.error('Sync failed:', error);
      alert(`클라우드 동기화 실패: ${error.message || '알 수 없는 오류'}\n(파일은 기기에 로컬로 저장되었습니다.)`);
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

      const isTxt = file.name.toLowerCase().endsWith('.txt');
      
      // txt 파일이면 epub으로 자동 변환
      let finalContent: ArrayBuffer;
      let finalFileName: string;
      let finalMimeType: string;

      if (isTxt) {
        try {
          const epubBlob = await convertTxtToEpub(content, file.name, 'auto');
          finalContent = await epubBlob.arrayBuffer();
          finalFileName = file.name.replace(/\.txt$/i, '.epub');
          finalMimeType = 'application/epub+zip';
        } catch (err) {
          console.error('txt→epub 변환 실패:', err);
          alert('txt→epub 변환에 실패했습니다.');
          return;
        }
      } else {
        // epub은 그대로
        finalContent = content;
        finalFileName = file.name;
        finalMimeType = 'application/epub+zip';
      }

      let bookId = finalFileName; // 기본값은 파일명
      
      // 1. 구글 드라이브 동기화 (클라우드 모드일 때 먼저 실행하여 ID 확보)
      if (!isOfflineMode && googleToken) {
        const driveId = await syncFileToDrive(finalFileName, finalContent);
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
        name: finalFileName,
        mimeType: finalMimeType,
      };
      
      await saveBookToLocal(book, finalContent);
      
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
