'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Book } from '../../types';
import {
  BOOK_COVER_CACHE_CHANGE_EVENT,
  loadBookCoverFromLocalV14,
} from '../../lib/bookCoverCache';
import { DEVICE_CONTENT_OWNER_KEY } from '../../lib/ownerIdentity';
import { supportsCachedBookCover } from '../../lib/bookCoverPolicy';
import { getBookFingerprint } from '../../lib/bookFingerprint';

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
  const activeEntriesRef = useRef(new Map<string, {
    fingerprint: string | null;
    revision: number;
    url?: string;
  }>());
  const visibleIdsRef = useRef<ReadonlySet<string>>(new Set());
  const coverRevisionsRef = useRef(new Map<string, number>());
  const pendingRevocationsRef = useRef<string[]>([]);

  useLayoutEffect(() => {
    visibleIdsRef.current = new Set(books.map((book) => book.id));
  }, [books]);

  useEffect(() => {
    const handleChange = (event: Event) => {
      const bookId = (event as CustomEvent<{ bookId?: string }>).detail?.bookId;
      if (!bookId || !visibleIdsRef.current.has(bookId)) return;
      coverRevisionsRef.current.set(
        bookId,
        (coverRevisionsRef.current.get(bookId) ?? 0) + 1,
      );
      setRevision((current) => current + 1);
    };
    window.addEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
    return () => window.removeEventListener(BOOK_COVER_CACHE_CHANGE_EVENT, handleChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const currentEntries = activeEntriesRef.current;
    void Promise.all(books.map(async (book) => {
      const fingerprint = getBookFingerprint(book);
      const bookRevision = coverRevisionsRef.current.get(book.id) ?? 0;
      const existing = currentEntries.get(book.id);
      if (
        existing
        && existing.fingerprint === fingerprint
        && existing.revision === bookRevision
      ) {
        return { bookId: book.id, fingerprint, revision: bookRevision, url: existing.url };
      }
      if (!supportsCachedBookCover(book)) {
        return { bookId: book.id, fingerprint, revision: bookRevision };
      }
      try {
        const image = await loadBookCoverFromLocalV14(DEVICE_CONTENT_OWNER_KEY, book);
        return { bookId: book.id, fingerprint, revision: bookRevision, image: image ?? undefined };
      } catch (error) {
        console.warn(`[Shelf] Failed to load cached book cover for ${book.id}:`, error);
        return { bookId: book.id, fingerprint, revision: bookRevision };
      }
    })).then((results) => {
      if (cancelled) return;
      const nextEntries = new Map<string, {
        fingerprint: string | null;
        revision: number;
        url?: string;
      }>();
      const nextUrls = new Map<string, string>();
      for (const result of results) {
        const url = result.url ?? (result.image ? URL.createObjectURL(result.image) : undefined);
        nextEntries.set(result.bookId, {
          fingerprint: result.fingerprint,
          revision: result.revision,
          url,
        });
        if (url) nextUrls.set(result.bookId, url);
      }
      for (const [bookId, previous] of currentEntries) {
        if (previous.url && nextEntries.get(bookId)?.url !== previous.url) {
          pendingRevocationsRef.current.push(previous.url);
        }
      }
      activeEntriesRef.current = nextEntries;
      setCoverUrls(nextUrls);
    });
    return () => {
      cancelled = true;
    };
  }, [books, revision]);

  useLayoutEffect(() => {
    const staleUrls = pendingRevocationsRef.current;
    pendingRevocationsRef.current = [];
    for (const url of staleUrls) URL.revokeObjectURL(url);
  }, [coverUrls]);

  useEffect(() => () => {
    revokeUrls(new Map(
      [...activeEntriesRef.current]
        .flatMap(([bookId, entry]) => entry.url ? [[bookId, entry.url] as const] : []),
    ));
    for (const url of pendingRevocationsRef.current) URL.revokeObjectURL(url);
    activeEntriesRef.current.clear();
    pendingRevocationsRef.current = [];
  }, []);

  return coverUrls;
};
