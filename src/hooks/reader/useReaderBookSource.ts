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
import type { FoliateBook, FoliateRenderer, FoliateViewElement } from '../foliate/types';
import {
  destroyPreparedBookSource,
  isAbortError,
  runReaderBookOpen,
  throwIfAborted,
} from '../../lib/readerLoadLifecycle';

type ReaderThemeColors = {
  bg: string;
  text: string;
};

type ReaderThemeTexture = {
  image: string;
  size: string;
};

type ReaderLayoutSetter = (
  layout: {
    flow?: 'paginated' | 'scrolled';
    margin?: number;
    gap?: string;
    maxColumnCount?: number;
    maxInlineSize?: string;
    animated?: boolean;
  },
  targetRenderer?: FoliateRenderer,
) => void;

type ReaderStyleSetter = (
  styles: {
    fontSize?: number;
    lineHeight?: number;
    paragraphSpacing?: number;
    fontFamily?: string;
    textAlign?: string;
    bgColor?: string;
    textColor?: string;
    bgImage?: string;
    bgSize?: string;
  },
  targetRenderer?: FoliateRenderer,
) => void;

interface UseReaderBookSourceOptions {
  book: Book;
  googleToken: string;
  initialCfi?: string;
  settings: ViewerSettings;
  themeColors: ReaderThemeColors;
  themeTexture: ReaderThemeTexture;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  openBook: (
    source: Blob | File | string | FoliateBook,
    initialCfi?: string,
    beforeInit?: (view: FoliateViewElement) => void | Promise<void>,
  ) => Promise<void>;
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
  const loadInputsRef = useRef({
    book,
    googleToken,
    initialCfi,
    openBook,
    onBack,
    settings,
    themeColors,
    themeTexture,
    setLayout,
    setStyle,
  });
  loadInputsRef.current = {
    book,
    googleToken,
    initialCfi,
    openBook,
    onBack,
    settings,
    themeColors,
    themeTexture,
    setLayout,
    setStyle,
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    const {
      book: targetBook,
      googleToken: targetGoogleToken,
      initialCfi: targetInitialCfi,
      openBook: openTargetBook,
      onBack: returnToShelf,
    } = loadInputsRef.current;

    const loadBook = async () => {
      try {
        await runReaderBookOpen({
          signal,
          prepare: async () => {
            const [localData, localMetadata] = await Promise.all([
              loadBookFromLocal(targetBook.id),
              loadBookMetadataFromLocal(targetBook.id),
            ]);
            throwIfAborted(signal);

            let prepared: Awaited<ReturnType<typeof prepareBookSource>> | null = null;
            const discardPrepared = () => {
              destroyPreparedBookSource(prepared);
              prepared = null;
            };
            const fingerprint = getBookFingerprint(targetBook);

            const prepareContent = async (content: StoredBookContent) => {
              const cachedArchiveIndex = targetBook.readerFormat === 'archive' && fingerprint
                ? await loadArchiveInspectionFromLocal(targetBook.id, fingerprint)
                : undefined;
              throwIfAborted(signal);
              let usedCachedArchiveIndex = Boolean(cachedArchiveIndex);

              let result: Awaited<ReturnType<typeof prepareBookSource>>;
              try {
                result = await prepareBookSource(targetBook, content, {
                  archiveImageIndex: cachedArchiveIndex,
                  signal,
                });
              } catch (error) {
                if (isAbortError(error) || !cachedArchiveIndex) throw error;
                console.warn('[Reader] Cached archive index is unusable, rebuilding:', error);
                usedCachedArchiveIndex = false;
                result = await prepareBookSource(targetBook, content, { signal });
              }

              try {
                throwIfAborted(signal);
                if (fingerprint && result.archiveImageIndex && !usedCachedArchiveIndex) {
                  try {
                    await saveArchiveInspectionToLocal(
                      targetBook.id,
                      fingerprint,
                      result.archiveImageIndex,
                    );
                  } catch (error) {
                    if (isAbortError(error)) throw error;
                    console.warn('[Reader] Failed to cache archive index:', error);
                  }
                }
                throwIfAborted(signal);
                return result;
              } catch (error) {
                destroyPreparedBookSource(result);
                throw error;
              }
            };

            try {
              if (!localData) throw new Error('No local cache');
              if (!shouldUseCachedBookContent(targetBook, localMetadata, navigator.onLine)) {
                throw new Error('Local cache is stale');
              }
              prepared = await prepareContent(localData as StoredBookContent);

              try {
                await saveBookMetadataToLocal(prepared.book, prepared.cacheContent);
              } catch (error) {
                if (isAbortError(error)) throw error;
                console.warn('[Reader] Failed to update local book metadata:', error);
              }
            } catch (localError) {
              if (isAbortError(localError)) {
                discardPrepared();
                throw localError;
              }
              if (localData) {
                console.warn('[Reader] Local cache is not usable, fetching remote:', localError);
              }
              if (!targetGoogleToken) {
                if (localData) throw localError;
                throw new Error('No Token');
              }

              const content = targetBook.readerFormat === 'epub'
                ? await fetchFullFile(targetBook.id, targetGoogleToken, signal)
                : await fetchFullFileBlob(targetBook.id, targetGoogleToken, signal);
              throwIfAborted(signal);
              prepared = await prepareContent(content);

              try {
                await saveBookToLocal(prepared.book, prepared.cacheContent);
              } catch (error) {
                if (isAbortError(error) || signal.aborted) throw error;
                console.warn('[Reader] Failed to save locally:', error);
                alert(error instanceof LocalStorageCapacityError
                  ? `${error.message}\n현재 세션에서는 클라우드 원본을 계속 읽습니다.`
                  : '오프라인 저장에 실패했습니다. 현재 세션에서는 클라우드 원본을 계속 읽습니다.');
              }
            }
            try {
              throwIfAborted(signal);
              if (!prepared) throw new Error('도서 준비 결과가 없습니다.');
              return prepared;
            } catch (error) {
              discardPrepared();
              throw error;
            }
          },
          open: (prepared) => openTargetBook(
            prepared.source,
            targetInitialCfi,
            prepared.format === 'epub'
              ? (openedView) => {
                const current = loadInputsRef.current;
                current.setLayout(
                  getReaderLayout(current.settings.navMode),
                  openedView.renderer,
                );
                current.setStyle(getReaderStyle(
                  current.settings,
                  current.themeColors,
                  current.themeTexture,
                ), openedView.renderer);
              }
              : undefined,
          ),
          commit: () => setIsLoaded(true),
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        console.error('[Reader] Failed to load book:', error);
        alert(error instanceof Error ? error.message : '도서를 열지 못했습니다.');
        returnToShelf();
      }
    };

    void loadBook();
    return () => controller.abort();
  }, [containerRef]);

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
