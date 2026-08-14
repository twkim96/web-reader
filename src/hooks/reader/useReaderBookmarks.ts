'use client';

import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark } from '../../types';
import { getProgressFromRelocateDetail } from '../foliate/progress';
import type { FoliateViewElement } from '../foliate/types';
import { getAutoBookmarkName, getLiveBookmarkPosition } from './bookmarkPositionPolicy';

type FoliateContentRef = MutableRefObject<FoliateViewElement | null>;

interface UseReaderBookmarksOptions {
  initialBookmarks?: Bookmark[];
  viewRef: FoliateContentRef;
  currentCfi: string;
  currentAnchorCfi: string;
  totalProgress: number;
  markUserProgressChange: () => void;
  saveBookmarks: (nextBookmarks: Bookmark[]) => Promise<boolean>;
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
  viewRef,
  currentCfi,
  currentAnchorCfi,
  totalProgress,
  markUserProgressChange,
  saveBookmarks,
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
    const next = normalizeAutoBookmarkNames(initialBookmarks || []);
    setBookmarksState((prev) => {
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      bookmarksRef.current = next;
      return next;
    });
  }, [initialBookmarks]);

  const getBookmarks = useCallback(() => bookmarksRef.current, []);

  const adoptResolvedBookmarks = useCallback((items: Bookmark[]) => {
    const next = sortByNewest(normalizeAutoBookmarkNames(items));
    return setBookmarks(next);
  }, [setBookmarks]);

  const getLivePosition = useCallback(() => {
    const live = viewRef.current?.lastLocation;
    return {
      ...getLiveBookmarkPosition(
        live?.cfi,
        live?.anchorCfi,
        currentCfi,
        currentAnchorCfi,
      ),
      progressPercent: live ? getProgressFromRelocateDetail(live) : null,
    };
  }, [currentAnchorCfi, currentCfi, viewRef]);

  const getPreviewText = useCallback(() => {
    try {
      const visibleText = viewRef.current?.lastLocation?.range?.toString()?.trim();
      if (visibleText) return visibleText.substring(0, 100).replace(/\s+/g, ' ');
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
    const position = getLivePosition();
    if (!position.progressCfi) return;
    markUserProgressChange();
    const progressPercent = position.progressPercent ?? totalProgress;

    const newMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'manual',
      name: getPreviewText(),
      cfi: position.bookmarkCfi,
      progressPercent,
      createdAt: Date.now(),
      color: '#f59e0b',
    };
    const updated = setBookmarks([newMark, ...bookmarksRef.current]);
    void saveBookmarks(updated);
  }, [getLivePosition, getPreviewText, markUserProgressChange, saveBookmarks, setBookmarks, totalProgress]);

  const deleteBookmark = useCallback((id: string) => {
    markUserProgressChange();
    const updated = setBookmarks(bookmarksRef.current.filter((bookmark) => bookmark.id !== id));
    void saveBookmarks(updated);
  }, [markUserProgressChange, saveBookmarks, setBookmarks]);

  const stageAutoBookmark = useCallback((prevCfi: string, prevPct: number) => {
    if (!prevCfi) return bookmarksRef.current;

    const live = getLivePosition();
    const progressPercent = live.progressPercent ?? prevPct;
    const autoMark: Bookmark = {
      id: crypto.randomUUID(),
      type: 'auto',
      name: getAutoBookmarkName(getPreviewText()),
      cfi: live.progressCfi || prevCfi,
      progressPercent,
      createdAt: Date.now(),
      color: '#64748b',
    };

    const manual = bookmarksRef.current.filter((bookmark) => bookmark.type === 'manual');
    const auto = bookmarksRef.current.filter((bookmark) => bookmark.type === 'auto').slice(0, 2);
    return [...manual, autoMark, ...auto];
  }, [getLivePosition, getPreviewText]);

  const commitBookmarks = useCallback((items: Bookmark[]) => setBookmarks(items), [setBookmarks]);

  const createAutoBookmark = useCallback((prevCfi: string, prevPct: number) => (
    commitBookmarks(stageAutoBookmark(prevCfi, prevPct))
  ), [commitBookmarks, stageAutoBookmark]);

  return {
    bookmarks,
    bookmarksRef,
    getBookmarks,
    adoptResolvedBookmarks,
    addBookmark,
    deleteBookmark,
    stageAutoBookmark,
    commitBookmarks,
    createAutoBookmark,
  };
};
