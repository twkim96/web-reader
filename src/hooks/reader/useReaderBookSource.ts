'use client';

import { MutableRefObject, useEffect, useRef, useState } from 'react';
import { Book, ViewerSettings } from '../../types';
import { ensureEpubBook } from '../../lib/bookContent';
import { fetchFullFile } from '../../lib/googleDrive';
import { loadBookFromLocal, saveBookToLocal } from '../../lib/localDB';

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
  openBook: (source: Blob | File | string, initialCfi?: string) => Promise<void>;
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

    const loadEpub = async () => {
      try {
        const localData = await loadBookFromLocal(book.id);
        let source: Blob;

        try {
          if (!localData) throw new Error('No local cache');
          const epub = await ensureEpubBook(book, localData);
          source = new Blob([epub.content], { type: 'application/epub+zip' });

          try {
            await saveBookToLocal(epub.book, epub.content);
          } catch (error) {
            console.warn('[EpubReader] Failed to update local epub cache:', error);
          }
        } catch (localError) {
          if (localData) console.warn('[EpubReader] Local cache is not usable, fetching remote:', localError);
          if (!googleToken) throw new Error('No Token');

          const buffer = await fetchFullFile(book.id, googleToken);
          const epub = await ensureEpubBook(book, buffer);
          source = new Blob([epub.content], { type: 'application/epub+zip' });

          try {
            await saveBookToLocal(epub.book, epub.content);
          } catch (error) {
            console.warn('[EpubReader] Failed to save locally:', error);
          }
        }

        await openBook(source, initialCfi);
        setLayout(getReaderLayout(settings.navMode));
        setStyle(getReaderStyle(settings, themeColors, themeTexture));
        setIsLoaded(true);
      } catch (error) {
        console.error('[EpubReader] Failed to load epub:', error);
        onBack();
      }
    };

    void loadEpub();
  }, [book, containerRef, googleToken, initialCfi, onBack, openBook, setLayout, setStyle, settings, themeColors, themeTexture]);

  useEffect(() => {
    if (!isLoaded) return;
    setStyle(getReaderStyle(settings, themeColors, themeTexture));
  }, [isLoaded, setStyle, settings, themeColors, themeTexture]);

  useEffect(() => {
    if (!isLoaded) return;
    setLayout(getReaderLayout(settings.navMode));
  }, [isLoaded, setLayout, settings.navMode]);

  return { isLoaded };
};
