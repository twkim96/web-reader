'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, SaveProgressOptions } from '../../types';
import { getAutoBookmarkName, getBookmarkPosition } from './bookmarkPositionPolicy';

type FoliateContentRef = MutableRefObject<{
  renderer?: {
    getContents?: () => { doc?: Document }[];
  };
} | null>;

interface UseReaderBookmarksOptions {
  initialBookmarks?: Bookmark[];
  remoteBookmarks?: Bookmark[];
  viewRef: FoliateContentRef;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  markUserProgressChange: () => void;
  saveProgressIfChanged: (
    cfi: string,
    pct: number,
    nextBookmarks: Bookmark[],
    options?: SaveProgressOptions,
  ) => boolean;
}

const sortByNewest = (items: Bookmark[]) => (
  [...items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
);

const normalizeAutoBookmarkNames = (items: Bookmark[]) => items.map((bookmark) => (
  bookmark.type === 'auto'
    ? { ...bookmark, name: getAutoBookmarkName(bookmark.name) }
    : bookmark
));

export const useReaderBookmarks = ({
  initialBookmarks,
  remoteBookmarks,
  viewRef,
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  markUserProgressChange,
  saveProgressIfChanged,
}: UseReaderBookmarksOptions) => {
  const [bookmarks, setBookmarksState] = useState<Bookmark[]>(() => (
    normalizeAutoBookmarkNames(initialBookmarks || [])
  ));
  const bookmarksRef = useRef<Bookmark[]>(normalizeAutoBookmarkNames(initialBookmarks || []));

  const setBookmarks = useCallback((nextBookmarks: Bookmark[]) => {
    bookmarksRef.current = nextBookmarks;
    setBookmarksState(nextBookmarks);
    return nextBookmarks;
  }, []);

  useEffect(() => {
    if (!remoteBookmarks) return;

    setBookmarksState((prev) => {
      const serverManual = remoteBookmarks.filter((bookmark) => bookmark.type === 'manual');
      const localAuto = prev.filter((bookmark) => bookmark.type === 'auto');
      const merged = sortByNewest([...serverManual, ...localAuto]);

      if (JSON.stringify(merged) === JSON.stringify(prev)) return prev;
      bookmarksRef.current = merged;
      return merged;
    });
  }, [remoteBookmarks]);

  const getBookmarks = useCallback(() => bookmarksRef.current, []);

  const getPreviewText = useCallback(() => {
    try {
      const contents = viewRef.current?.renderer?.getContents?.();
      if (!contents || contents.length === 0) return '';
      const text = contents[0]?.doc?.body?.innerText || '';
      return text.trim().substring(0, 100).replace(/\s+/g, ' ') || '북마크';
    } catch (error) {
      console.warn('[EpubReader] Failed to get preview text:', error);
      return '북마크';
    }
  }, [viewRef]);

  const addBookmark = useCallback(() => {
    if (!currentCfi) return;
    markUserProgressChange();
    const position = getBookmarkPosition(currentCfi, currentAnchorCfi);

    const newMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'manual',
      name: getPreviewText(),
      cfi: position.bookmarkCfi,
      progressPercent: totalProgress,
      createdAt: Date.now(),
      color: '#f59e0b',
    };
    const updated = setBookmarks([newMark, ...bookmarksRef.current]);
    saveProgressIfChanged(position.progressCfi, totalProgress, updated, {
      anchorCfi: position.anchorCfi,
    });
  }, [currentAnchorCfi, currentCfi, getPreviewText, markUserProgressChange, saveProgressIfChanged, setBookmarks, totalProgress]);

  const deleteBookmark = useCallback((id: string) => {
    markUserProgressChange();
    const updated = setBookmarks(bookmarksRef.current.filter((bookmark) => bookmark.id !== id));
    const position = getBookmarkPosition(currentCfi, currentAnchorCfi);
    saveProgressIfChanged(position.progressCfi, totalProgress, updated, {
      anchorCfi: position.anchorCfi,
    });
  }, [currentAnchorCfi, currentCfi, markUserProgressChange, saveProgressIfChanged, setBookmarks, totalProgress]);

  const createAutoBookmark = useCallback((prevCfi: string, prevPct: number) => {
    if (!prevCfi) return bookmarksRef.current;

    const autoMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'auto',
      name: getAutoBookmarkName(getPreviewText()),
      cfi: prevCfi,
      progressPercent: prevPct,
      createdAt: Date.now(),
      color: '#64748b',
    };

    const manual = bookmarksRef.current.filter((bookmark) => bookmark.type === 'manual');
    const auto = bookmarksRef.current.filter((bookmark) => bookmark.type === 'auto').slice(0, 2);
    return setBookmarks([...manual, autoMark, ...auto]);
  }, [getPreviewText, setBookmarks]);

  return {
    bookmarks,
    bookmarksRef,
    getBookmarks,
    addBookmark,
    deleteBookmark,
    createAutoBookmark,
  };
};
