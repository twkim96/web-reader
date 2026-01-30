// src/hooks/useBookLoader.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchFullFile } from '../lib/googleDrive';
// [Modified] 변경된 함수명 import
import { loadBookFromLocal, saveBookToLocal } from '../lib/localDB';
import { Book, ViewerSettings } from '../types';

export const useBookLoader = (
  book: Book, 
  googleToken: string, 
  settings: ViewerSettings,
  onBack: () => void
) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const fullContent = useRef<string>("");
  const rawBuffer = useRef<ArrayBuffer | null>(null);

  const decodeData = useCallback((buffer: ArrayBuffer, mode: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le') => {
    const view = new Uint8Array(buffer);
    // BOM 체크
    const isUTF16LE = view[0] === 0xFF && view[1] === 0xFE;
    const isUTF16BE = view[0] === 0xFE && view[1] === 0xFF;
    
    if (mode === 'auto') {
      try {
        const decoder = new TextDecoder(
          (isUTF16LE || isUTF16BE) ? (isUTF16LE ? 'utf-16le' : 'utf-16be') : 'utf-8', 
          { fatal: true }
        );
        fullContent.current = decoder.decode(buffer);
      } catch (e) {
        // UTF-8 실패 시 EUC-KR 시도 (한국 텍스트 파일 대비)
        fullContent.current = new TextDecoder('euc-kr').decode(buffer);
      }
    } else {
      fullContent.current = new TextDecoder(mode).decode(buffer);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        let buffer: ArrayBuffer;
        // 1. 로컬 DB에서 먼저 찾기
        const offlineData = await loadBookFromLocal(book.id);
        
        if (offlineData) {
          buffer = offlineData; // 로컬에 있으면 그거 사용
        } else {
          // 2. 없으면 구글 드라이브에서 다운로드
          if (!googleToken) throw new Error("No Token");
          buffer = await fetchFullFile(book.id, googleToken);
          
          // [Modified] 책 정보(book)와 내용(buffer)을 함께 저장
          // 이 과정에서 META_STORE에 데이터가 생성됩니다.
          await saveBookToLocal(book, buffer);
        }

        if (isMounted) {
          rawBuffer.current = buffer;
          decodeData(buffer, settings.encoding);
          setIsLoaded(true);
        }
      } catch (e) {
        console.error("Load failed", e);
        if (isMounted) onBack();
      }
    };

    init();

    return () => { isMounted = false; };
  }, [book, googleToken, onBack]); // settings.encoding 제외 (아래 효과에서 처리)

  // 인코딩 설정이 바뀌면 버퍼만 다시 디코딩 (새로고침 불필요)
  useEffect(() => {
    if (rawBuffer.current && isLoaded) {
      decodeData(rawBuffer.current, settings.encoding);
      // 강제 리렌더링을 위해 필요하다면 상태 업데이트를 추가할 수 있으나,
      // 보통 상위 Reader가 settings 변경 시 리렌더링 되므로 fullContent.current가 반영됨.
      // 리액트 상태 갱신이 필요하면 아래와 같이 더미 상태를 쓸 수 있음
      setIsLoaded(prev => !prev); 
      setTimeout(() => setIsLoaded(true), 0);
    }
  }, [settings.encoding, decodeData, isLoaded]);

  return { isLoaded, fullContent };
};