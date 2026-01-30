// src/hooks/useBookLoader.ts
import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchFullFile } from '../lib/googleDrive';
import { getOfflineBook, saveOfflineBook } from '../lib/localDB';
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
    const isUTF16LE = view[0] === 0xFF && view[1] === 0xFE;
    const isUTF16BE = view[0] === 0xFE && view[1] === 0xFF;
    
    if (mode === 'auto') {
      try {
        const decoder = new TextDecoder((isUTF16LE || isUTF16BE) ? (isUTF16LE ? 'utf-16le' : 'utf-16be') : 'utf-8', { fatal: true });
        fullContent.current = decoder.decode(buffer);
      } catch (e) {
        fullContent.current = new TextDecoder('euc-kr').decode(buffer);
      }
    } else {
      fullContent.current = new TextDecoder(mode).decode(buffer);
    }
  }, []);

  useEffect(() => {
    const init = async () => {
      try {
        let buffer: ArrayBuffer;
        const offlineData = await getOfflineBook(book.id);
        
        if (offlineData) {
          buffer = offlineData.data;
        } else {
          buffer = await fetchFullFile(book.id, googleToken);
          saveOfflineBook(book.id, book.name, buffer).catch(console.error);
        }
        
        rawBuffer.current = buffer;
        decodeData(buffer, settings.encoding);
        setIsLoaded(true);
      } catch (err) { 
        console.error(err); 
        alert("파일을 불러오는데 실패했습니다.");
        onBack();
      }
    };
    init();
  }, [book.id, googleToken, decodeData, settings.encoding, onBack, book.name]);

  return { isLoaded, fullContent };
};