'use client';

import { useEffect, useRef, useState } from 'react';
import type { Book } from '../../types';
import {
  BOOK_COVER_CACHE_CHANGE_EVENT,
  loadBookCoverFromLocalV14,
} from '../../lib/bookCoverCache';
import { DEVICE_CONTENT_OWNER_KEY } from '../../lib/ownerIdentity';
import { supportsCachedBookCover } from '../../lib/bookCoverPolicy';

const revokeUrls = (urls: ReadonlyMap<string, string>) => {
  for (const url of urls.values()) URL.revokeObjectURL(url);
};

export const useShelfBookCover = (book: Book) => {
  const [revision, setRevision] = useState(0);
  const [coverUrl, setCoverUrl] = useState<string | undefined>(undefined);
  const activeUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const bookId = (event as CustomEvent<{ bookId?: string }>).detail?.bookId;
      if (bookId === book.id) setRevision((current) => current + 1);
    };
    window.addEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
  }, [book.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const image = supportsCachedBookCover(book)
        ? await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, book)
        : null;
      if (cancelled) return;
      const nextUrl = image ? URL.createObjectURL(image) : undefined;
      const previousUrl = activeUrlRef.current;
      activeUrlRef.current = nextUrl;
      setCoverUrl(nextUrl);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    })().catch((error) => {
      if (!cancelled) console.warn('[Shelf] Failed to load cached book cover:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [book, revision]);

  useEffect(() => () => {
    if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current);
    activeUrlRef.current = undefined;
  }, []);

  return coverUrl;
};

export const useShelfBookCovers = (books: readonly Book[]) => {
  const [revision, setRevision] = useState(0);
  const [coverUrls, setCoverUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  const activeUrlsRef = useRef<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const visibleIds = new Set(books.map((book) => book.id));
    const handleChange = (event: Event) => {
      const bookId = (event as CustomEvent<{ bookId?: string }>).detail?.bookId;
      if (bookId && visibleIds.has(bookId)) setRevision((current) => current + 1);
    };
    window.addEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
  }, [books]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(books.map(async (book) => {
      if (!supportsCachedBookCover(book)) return null;
      const image = await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, book);
      return image ? [book.id, image] as const : null;
    })).then((entries) => {
      if (cancelled) return;
      const nextUrls = new Map(entries.flatMap((entry) => (
        entry ? [[entry[0], URL.createObjectURL(entry[1])] as const] : []
      )));
      const previousUrls = activeUrlsRef.current;
      activeUrlsRef.current = nextUrls;
      setCoverUrls(nextUrls);
      revokeUrls(previousUrls);
    }).catch((error) => {
      if (!cancelled) console.warn('[Shelf] Failed to load cached book covers:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [books, revision]);

  useEffect(() => () => {
    revokeUrls(activeUrlsRef.current);
    activeUrlsRef.current = new Map();
  }, []);

  return coverUrls;
};
