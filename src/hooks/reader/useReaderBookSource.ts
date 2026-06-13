'use client';

import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { Book, ViewerSettings } from '../../types';
import { prepareBookSource, type StoredBookContent } from '../../lib/bookContent';
import { fetchFullFile, fetchFullFileBlob } from '../../lib/googleDrive';
import {
  loadArchiveInspectionFromLocal,
  loadBookFromLocal,
  loadBookMetadataFromLocal,
  LocalStorageCapacityError,
  saveArchiveInspectionToLocal,
  saveBookMetadataToLocal,
  saveBookToLocal,
} from '../../lib/localDB';
import {
  getBookFingerprint,
  shouldUseCachedBookContent,
} from '../../lib/bookFingerprint';
import type { FoliateBook } from '../foliate/types';

type ReaderThemeColors = {
  bg: string;
  text: string;
};

type ReaderThemeTexture = {
  image: string;
  size: string;
};

type ReaderLayoutSetter = (layout: {
  flow?: 'paginated' | 'scrolled';
  margin?: number;
  gap?: string;
  maxColumnCount?: number;
  maxInlineSize?: string;
  animated?: boolean;
}) => void;

type ReaderStyleSetter = (styles: {
  fontSize?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  fontFamily?: string;
  textAlign?: string;
  bgColor?: string;
  textColor?: string;
  bgImage?: string;
  bgSize?: string;
}) => void;

interface UseReaderBookSourceOptions {
  book: Book;
  googleToken: string;
  initialCfi?: string;
  settings: ViewerSettings;
  themeColors: ReaderThemeColors;
  themeTexture: ReaderThemeTexture;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  openBook: (source: Blob | File | string | FoliateBook, initialCfi?: string) => Promise<void>;
  setLayout: ReaderLayoutSetter;
  setStyle: ReaderStyleSetter;
  onBack: () => void;
}

const getReaderLayout = (navMode: ViewerSettings['navMode']) => ({
  flow: navMode === 'scroll' ? 'scrolled' as const : 'paginated' as const,
  maxColumnCount: 1,
  margin: 0,
  gap: '5%',
  maxInlineSize: '1000px',
});

const getReaderStyle = (
  settings: ViewerSettings,
  themeColors: ReaderThemeColors,
  themeTexture: ReaderThemeTexture
) => ({
  fontSize: settings.fontSize,
  lineHeight: settings.lineHeight,
  paragraphSpacing: settings.paragraphSpacing ?? 1,
  fontFamily: settings.fontFamily,
  textAlign: settings.textAlign,
  bgColor: themeColors.bg,
  textColor: themeColors.text,
  bgImage: themeTexture.image,
  bgSize: themeTexture.size,
});

export const useReaderBookSource = ({
  book,
  googleToken,
  initialCfi,
  settings,
  themeColors,
  themeTexture,
  containerRef,
  openBook,
  setLayout,
  setStyle,
  onBack,
}: UseReaderBookSourceOptions) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const loadAttempted = useRef(false);

  useEffect(() => {
    if (loadAttempted.current) return;
    if (!containerRef.current) return;
    loadAttempted.current = true;

    const loadBook = async () => {
      try {
        const [localData, localMetadata] = await Promise.all([
          loadBookFromLocal(book.id),
          loadBookMetadataFromLocal(book.id),
        ]);
        let prepared: Awaited<ReturnType<typeof prepareBookSource>>;
        const fingerprint = getBookFingerprint(book);

        const prepareContent = async (content: StoredBookContent) => {
          const cachedArchiveIndex = book.readerFormat === 'archive' && fingerprint
            ? await loadArchiveInspectionFromLocal(book.id, fingerprint)
            : undefined;
          let usedCachedArchiveIndex = Boolean(cachedArchiveIndex);

          let result: Awaited<ReturnType<typeof prepareBookSource>>;
          try {
            result = await prepareBookSource(book, content, {
              archiveImageIndex: cachedArchiveIndex,
            });
          } catch (error) {
            if (!cachedArchiveIndex) throw error;
            console.warn('[Reader] Cached archive index is unusable, rebuilding:', error);
            usedCachedArchiveIndex = false;
            result = await prepareBookSource(book, content);
          }

          if (fingerprint && result.archiveImageIndex && !usedCachedArchiveIndex) {
            try {
              await saveArchiveInspectionToLocal(
                book.id,
                fingerprint,
                result.archiveImageIndex,
              );
            } catch (error) {
              console.warn('[Reader] Failed to cache archive index:', error);
            }
          }
          return result;
        };

        try {
          if (!localData) throw new Error('No local cache');
          if (!shouldUseCachedBookContent(book, localMetadata, navigator.onLine)) {
            throw new Error('Local cache is stale');
          }
          prepared = await prepareContent(localData as StoredBookContent);

          try {
            await saveBookMetadataToLocal(prepared.book, prepared.cacheContent);
          } catch (error) {
            console.warn('[Reader] Failed to update local book metadata:', error);
          }
        } catch (localError) {
          if (localData) console.warn('[Reader] Local cache is not usable, fetching remote:', localError);
          if (!googleToken) {
            if (localData) throw localError;
            throw new Error('No Token');
          }

          const content = book.readerFormat === 'epub'
            ? await fetchFullFile(book.id, googleToken)
            : await fetchFullFileBlob(book.id, googleToken);
          prepared = await prepareContent(content);

          try {
            await saveBookToLocal(prepared.book, prepared.cacheContent);
          } catch (error) {
            console.warn('[Reader] Failed to save locally:', error);
            alert(error instanceof LocalStorageCapacityError
              ? `${error.message}\n현재 세션에서는 클라우드 원본을 계속 읽습니다.`
              : '오프라인 저장에 실패했습니다. 현재 세션에서는 클라우드 원본을 계속 읽습니다.');
          }
        }

        await openBook(prepared.source, initialCfi);
        if (prepared.format === 'epub') {
          setLayout(getReaderLayout(settings.navMode));
          setStyle(getReaderStyle(settings, themeColors, themeTexture));
        }
        setIsLoaded(true);
      } catch (error) {
        console.error('[Reader] Failed to load book:', error);
        alert(error instanceof Error ? error.message : '도서를 열지 못했습니다.');
        onBack();
      }
    };

    void loadBook();
  }, [book, containerRef, googleToken, initialCfi, onBack, openBook, setLayout, setStyle, settings, themeColors, themeTexture]);

  useEffect(() => {
    if (!isLoaded || book.readerFormat !== 'epub') return;
    setStyle(getReaderStyle(settings, themeColors, themeTexture));
  }, [book.readerFormat, isLoaded, setStyle, settings, themeColors, themeTexture]);

  useEffect(() => {
    if (!isLoaded || book.readerFormat !== 'epub') return;
    setLayout(getReaderLayout(settings.navMode));
  }, [book.readerFormat, isLoaded, setLayout, settings.navMode]);

  return { isLoaded };
};
