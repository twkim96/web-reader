'use client';

import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { Book, ViewerSettings } from '../../types';
import { prepareBookSource, type StoredBookContent } from '../../lib/bookContent';
import { fetchFullFile, fetchFullFileBlob } from '../../lib/googleDrive';
import {
  loadArchiveInspectionFromLocalV5,
  loadBookFromLocalV5,
  loadBookMetadataFromLocalV5,
  saveArchiveInspectionToLocalV5,
  saveBookMetadataToLocalV5,
  saveBookToLocalV5,
} from '../../lib/localDBV5';
import { LocalStorageCapacityError } from '../../lib/localDB';
import { DEVICE_CONTENT_OWNER_KEY } from '../../lib/ownerIdentity';
import { ownerRuntime } from '../../lib/ownerRuntime';
import {
  getBookFingerprint,
  shouldUseCachedBookContent,
} from '../../lib/bookFingerprint';
import type { FoliateBook, FoliateRenderer, FoliateViewElement } from '../foliate/types';
import {
  destroyPreparedBookSource,
  isAbortError,
  ReaderLoadTimeoutError,
  runWithTimeout,
  runReaderBookOpen,
  throwIfAborted,
} from '../../lib/readerLoadLifecycle';
import { getReaderMaxColumnCount } from '../../lib/readerNavigation';
import { traceReaderOpenPerformance } from '../../lib/readerBootstrapTrace';
import {
  cacheOpenedBookCoverIfMissing,
  supportsCachedBookCover,
} from '../../lib/bookCover';

type ReaderThemeColors = {
  bg: string;
  text: string;
};

type ReaderThemeTexture = {
  image: string;
  size: string;
};

const ARCHIVE_LOAD_TIMEOUT_MS = 90_000;
const ARCHIVE_LOAD_TIMEOUT_MESSAGE = '압축 파일을 90초 안에 열지 못했습니다. 서재로 돌아갑니다.';

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
) => Promise<void>;

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

const getReaderLayout = (
  navMode: ViewerSettings['navMode'],
  landscapeTwoPage: boolean,
) => ({
  flow: navMode === 'scroll' ? 'scrolled' as const : 'paginated' as const,
  swipeNavigation: navMode === 'scroll',
  maxColumnCount: getReaderMaxColumnCount(navMode, landscapeTwoPage),
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
  const appliedStyleKeyRef = useRef<string | null>(null);
  const appliedLayoutKeyRef = useRef<string | null>(null);
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
    const owner = ownerRuntime.capture();
    if (!owner) return;
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
      const bookOpenStartedAt = performance.now();
      traceReaderOpenPerformance({
        phase: 'reader-open-start',
        sizeBytes: typeof targetBook.size === 'number' && Number.isFinite(targetBook.size)
          ? targetBook.size
          : undefined,
        status: targetBook.sourceFormat ?? targetBook.readerFormat,
      });
      const deferredPersistence: Array<() => void> = [];
      const runDeferredPersistence = () => {
        const tasks = deferredPersistence.splice(0);
        window.setTimeout(() => tasks.forEach((task) => task()), 0);
      };

      try {
        await runReaderBookOpen({
          signal,
          prepare: async () => {
            let phaseStartedAt = performance.now();
            const [localData, localMetadata] = await Promise.all([
              loadBookFromLocalV5(DEVICE_CONTENT_OWNER_KEY, targetBook.id),
              loadBookMetadataFromLocalV5(DEVICE_CONTENT_OWNER_KEY, targetBook.id),
            ]);
            traceReaderOpenPerformance({
              phase: 'indexeddb-book-read',
              durationMs: performance.now() - phaseStartedAt,
              sizeBytes: localData instanceof Blob
                ? localData.size
                : localData instanceof ArrayBuffer
                  ? localData.byteLength
                  : undefined,
              status: localData ? 'hit' : 'miss',
            });
            if (!ownerRuntime.isCurrent(owner)) throw new DOMException('Owner changed', 'AbortError');
            throwIfAborted(signal);

            let prepared: Awaited<ReturnType<typeof prepareBookSource>> | null = null;
            const discardPrepared = () => {
              destroyPreparedBookSource(prepared);
              prepared = null;
            };
            const fingerprint = getBookFingerprint(targetBook);

            const prepareContent = async (content: StoredBookContent) => {
              const cachedArchiveIndex = targetBook.readerFormat === 'archive' && fingerprint
                ? await loadArchiveInspectionFromLocalV5(
                  DEVICE_CONTENT_OWNER_KEY,
                  targetBook.id,
                  fingerprint,
                )
                : undefined;
              if (!ownerRuntime.isCurrent(owner)) throw new DOMException('Owner changed', 'AbortError');
              throwIfAborted(signal);
              let usedCachedArchiveIndex = Boolean(cachedArchiveIndex);

              let result: Awaited<ReturnType<typeof prepareBookSource>>;
              const prepareStartedAt = performance.now();
              try {
                const prepare = prepareBookSource(targetBook, content, {
                  archiveImageIndex: cachedArchiveIndex,
                  signal,
                });
                result = targetBook.readerFormat === 'archive'
                  ? await runWithTimeout(prepare, ARCHIVE_LOAD_TIMEOUT_MS, ARCHIVE_LOAD_TIMEOUT_MESSAGE)
                  : await prepare;
              } catch (error) {
                if (
                  isAbortError(error)
                  || error instanceof ReaderLoadTimeoutError
                  || !cachedArchiveIndex
                ) throw error;
                console.warn('[Reader] Cached archive index is unusable, rebuilding:', error);
                usedCachedArchiveIndex = false;
                const prepare = prepareBookSource(targetBook, content, { signal });
                result = targetBook.readerFormat === 'archive'
                  ? await runWithTimeout(prepare, ARCHIVE_LOAD_TIMEOUT_MS, ARCHIVE_LOAD_TIMEOUT_MESSAGE)
                  : await prepare;
              }

              traceReaderOpenPerformance({
                phase: 'prepare-book-source',
                durationMs: performance.now() - prepareStartedAt,
                sizeBytes: content instanceof Blob ? content.size : content.byteLength,
                status: result.format,
              });

              try {
                throwIfAborted(signal);
                if (fingerprint && result.archiveImageIndex && !usedCachedArchiveIndex) {
                  const archiveImageIndex = result.archiveImageIndex;
                  deferredPersistence.push(() => {
                    if (!ownerRuntime.isCurrent(owner)) return;
                    void saveArchiveInspectionToLocalV5(
                      DEVICE_CONTENT_OWNER_KEY,
                      targetBook.id,
                      fingerprint,
                      archiveImageIndex,
                    ).catch((error) => {
                      if (!isAbortError(error)) {
                        console.warn('[Reader] Failed to cache archive index:', error);
                      }
                    });
                  });
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
              const preparedFromLocal = await prepareContent(localData as StoredBookContent);
              prepared = preparedFromLocal;

              deferredPersistence.push(() => {
                if (!ownerRuntime.isCurrent(owner)) return;
                void saveBookMetadataToLocalV5(
                  DEVICE_CONTENT_OWNER_KEY,
                  preparedFromLocal.book,
                  preparedFromLocal.cacheContent,
                ).catch((error) => {
                  if (!isAbortError(error)) {
                    console.warn('[Reader] Failed to update local book metadata:', error);
                  }
                });
              });
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

              phaseStartedAt = performance.now();
              const content = targetBook.readerFormat === 'epub'
                ? await fetchFullFile(targetBook.id, targetGoogleToken, signal)
                : await fetchFullFileBlob(targetBook.id, targetGoogleToken, signal);
              traceReaderOpenPerformance({
                phase: 'cloud-book-download',
                durationMs: performance.now() - phaseStartedAt,
                sizeBytes: content instanceof Blob ? content.size : content.byteLength,
              });
              throwIfAborted(signal);
              const preparedFromRemote = await prepareContent(content);
              prepared = preparedFromRemote;

              deferredPersistence.push(() => {
                if (!ownerRuntime.isCurrent(owner)) return;
                void saveBookToLocalV5(
                  DEVICE_CONTENT_OWNER_KEY,
                  preparedFromRemote.book,
                  preparedFromRemote.cacheContent,
                ).catch((error) => {
                  if (isAbortError(error) || signal.aborted) return;
                  console.warn('[Reader] Failed to save locally:', error);
                  alert(error instanceof LocalStorageCapacityError
                    ? `${error.message}\n현재 세션에서는 클라우드 원본을 계속 읽습니다.`
                    : '오프라인 저장에 실패했습니다. 현재 세션에서는 클라우드 원본을 계속 읽습니다.');
                });
              });
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
          open: async (prepared) => {
            const shouldCacheCover = supportsCachedBookCover(targetBook);
            const open = openTargetBook(
              prepared.source,
              targetInitialCfi,
              prepared.format === 'epub' || shouldCacheCover
                ? async (openedView) => {
                  if (prepared.format === 'epub') {
                    const current = loadInputsRef.current;
                    const initialLayout = getReaderLayout(
                      current.settings.navMode,
                      current.settings.landscapeTwoPage === true,
                    );
                    const initialStyle = getReaderStyle(
                      current.settings,
                      current.themeColors,
                      current.themeTexture,
                    );
                    current.setLayout(initialLayout, openedView.renderer);
                    appliedLayoutKeyRef.current = JSON.stringify(initialLayout);
                    await current.setStyle(initialStyle, openedView.renderer);
                    appliedStyleKeyRef.current = JSON.stringify(initialStyle);
                  }
                  if (shouldCacheCover) {
                    deferredPersistence.push(() => {
                      if (!ownerRuntime.isCurrent(owner) || signal.aborted) return;
                      void cacheOpenedBookCoverIfMissing(
                        DEVICE_CONTENT_OWNER_KEY,
                        targetBook,
                        openedView,
                        signal,
                      ).catch((error) => {
                        if (!isAbortError(error)) {
                          console.warn('[Reader] Failed to cache book cover:', error);
                        }
                      });
                    });
                  }
                }
                : undefined,
            );
            if (prepared.format === 'archive') {
              await runWithTimeout(open, ARCHIVE_LOAD_TIMEOUT_MS, ARCHIVE_LOAD_TIMEOUT_MESSAGE);
              return;
            }
            await open;
          },
          commit: () => {
            if (!ownerRuntime.isCurrent(owner)) return;
            traceReaderOpenPerformance({
              phase: 'reader-open-total',
              durationMs: performance.now() - bookOpenStartedAt,
              status: 'committed',
            });
            setIsLoaded(true);
            runDeferredPersistence();
          },
        });
      } catch (error) {
        if (isAbortError(error) || signal.aborted) return;
        console.error('[Reader] Failed to load book:', error);
        alert(error instanceof Error ? error.message : '도서를 열지 못했습니다.');
        returnToShelf();
      }
    };

    void loadBook();
    const unregister = ownerRuntime.registerDisposer(() => controller.abort());
    return () => {
      unregister();
      controller.abort();
    };
  }, [containerRef]);

  useEffect(() => {
    if (!isLoaded || book.readerFormat !== 'epub') return;
    const nextStyle = getReaderStyle(settings, themeColors, themeTexture);
    const nextKey = JSON.stringify(nextStyle);
    if (appliedStyleKeyRef.current === nextKey) return;
    appliedStyleKeyRef.current = nextKey;
    void setStyle(nextStyle);
  }, [book.readerFormat, isLoaded, setStyle, settings, themeColors, themeTexture]);

  useEffect(() => {
    if (!isLoaded || book.readerFormat !== 'epub') return;
    const nextLayout = getReaderLayout(
      settings.navMode,
      settings.landscapeTwoPage === true,
    );
    const nextKey = JSON.stringify(nextLayout);
    if (appliedLayoutKeyRef.current === nextKey) return;
    appliedLayoutKeyRef.current = nextKey;
    setLayout(nextLayout);
  }, [
    book.readerFormat,
    isLoaded,
    setLayout,
    settings.landscapeTwoPage,
    settings.navMode,
  ]);

  return { isLoaded };
};
