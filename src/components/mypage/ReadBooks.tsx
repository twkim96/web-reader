'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { useMyPageReadingFiles } from '../../hooks/useMyPageList';
import { formatReadingDuration } from '../../lib/readingStatistics';
import { readHiddenReadingStatisticsSessionIds, READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY } from '../../lib/readingStatisticsSessionVisibility';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import { prepareReadBooks, selectSyncedReadingSessions, type ReadBook } from '../../lib/readBooks';
import { findReviewWork, indexReviewWorks, MY_PAGE_DASHBOARD_BOOK_LIMIT, type MyPageReview } from '../../lib/myPageSocial';
import { BookCover } from './BookCover';
import { BookDetailLink } from './BookDetailLink';
import { DashboardBookRow } from './DashboardBookRow';
import { ListSort } from './ListSort';
import { ReviewStar } from './ReviewStar';
import type { PublicBookMetadata } from '../../lib/publicBookMetadata';
import { readCachedReadBookMetadata, type ReadBookMetadataMatch } from '../../lib/readBookMetadataCache';
import { useMyPageSort } from '../../hooks/useMyPageSort';

const readSorts = [
  ['recent', '최근 읽은 순'],
  ['time', '읽은 시간순'],
  ['progress', '진행률순'],
  ['title', '가나다순'],
] as const;
type ReadSort = typeof readSorts[number][0];
const readOrder: Record<Exclude<ReadSort, 'recent'>, (a: ReadBook, b: ReadBook) => number> = {
  time: (a, b) => b.totalMs - a.totalMs,
  progress: (a, b) => b.progressPercent - a.progressPercent,
  title: (a, b) => a.title.localeCompare(b.title, 'ko'),
};

type Metrics = Pick<ReadBook, 'totalMs' | 'progressPercent'>;
const formatMetrics = ({ totalMs, progressPercent }: Metrics) => (
  `${formatReadingDuration(totalMs)} 읽음 · 최고 ${progressPercent.toFixed(1)}%`
);

const secondaryAction = 'min-h-10 shrink-0 rounded-full px-3 text-xs font-medium hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] hover:text-accent-500';

function ReadBookRow({ book, detailId, onOpenBook, rating }: {
  book: ReadBook;
  detailId: string | null;
  onOpenBook: (book: ReadBook, focusReview?: boolean) => void;
  rating: number;
}) {
  return (
    <article className="mypage-book-list-item">
      <div className="relative flex items-start gap-3 sm:gap-4">
        <BookCover url={book.coverUrl} identity={detailId ?? book.rowKey ?? book.id} title={book.title} coverLoading="direct-with-proxy-fallback" />
        <div className="min-w-0 flex-1">
          <BookDetailLink bookId={detailId} onOpen={() => onOpenBook(book)} label={book.title}
            className="group block rounded-lg after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline-2 focus-visible:after:outline-accent-500">
            <h3 className="truncate text-sm font-semibold leading-5 group-hover:text-accent-500">{book.title}</h3>
            <p className="mt-0.5 truncate text-xs leading-4 opacity-65">{formatMetrics(book)}</p>
          </BookDetailLink>
          <BookDetailLink bookId={detailId} focusReview onOpen={() => onOpenBook(book, true)}
            label={`${book.title} 내 평가, ${rating ? `별점 ${rating}점` : '미평가'}`}
            className="relative z-10 flex h-8 w-fit items-center gap-0.5 rounded-sm hover:text-accent-500 focus-visible:outline-2">
            {[1, 2, 3, 4, 5].map((value) => (
              <ReviewStar key={value} position={value} rating={rating} size={15} />
            ))}
          </BookDetailLink>
        </div>
      </div>
    </article>
  );
}

export function ReadBooks({ ownerKey, onShowAll, onOpenBook, getDetailId, onRetryCatalog, reviews, reviewError, onRetryReviews }: {
  ownerKey: OwnerKey;
  onShowAll?: () => void;
  getDetailId: (book: ReadBook) => string | null;
  onRetryCatalog?: () => void;
  onOpenBook: (book: ReadBook, focusReview?: boolean) => void;
  reviews?: MyPageReview[];
  reviewError?: string;
  onRetryReviews?: () => void;
}) {
  const guest = isGuestOwner(ownerKey);
  const { data: published } = useMyPageReadingFiles(ownerKey, !guest);
  const archived = published?.history;
  const preview = Boolean(onShowAll);
  const [books, setBooks] = useState<ReadBook[] | null>(null);
  const [error, setError] = useState(false);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [retry, setRetry] = useState(0);
  const [sort, setSort] = useMyPageSort(ownerKey, 'read', readSorts, 'recent');
  const [visibleCount, setVisibleCount] = useState(20);
  const [failedCount, setFailedCount] = useState(0);
  const accountIndex = useMemo(() => indexReviewWorks(reviews ?? []), [reviews]);
  const retained = useRef<{ owner: OwnerKey; matches: Map<string, ReadBookMetadataMatch> }>({ owner: ownerKey, matches: new Map() });

  useEffect(() => {
    if (guest) return;
    const controller = new AbortController();
    if (retained.current.owner !== ownerKey) {
      retained.current = { owner: ownerKey, matches: new Map() };
      setBooks(null);
      setFailedCount(0);
      setError(false);
    }
    let disposed = false;
    let running = false;
    let dirty = false;
    let timer: number | undefined;
    let renderTimer: number | undefined;
    const load = async () => {
      if (disposed) return;
      if (running) { dirty = true; return; }
      running = true;
      try {
        const stored = await getLocalReadingSessionsV11(ownerKey);
        if (disposed) return;
        const hidden = readHiddenReadingStatisticsSessionIds(ownerKey);
        const sessions = selectSyncedReadingSessions(stored, ownerKey, hidden);
        const archive = hidden.size ? null : archived;
        const fileDates = new Map<string, number>();
        for (const session of sessions) {
          fileDates.set(session.bookId, Math.max(fileDates.get(session.bookId) ?? 0, session.endedAtClient));
        }
        const latestByName = new Map<string, number>();
        for (const { bookId, bookTitle } of sessions) {
          latestByName.set(bookTitle, Math.max(latestByName.get(bookTitle) ?? 0, fileDates.get(bookId)!));
        }
        for (const file of archive?.files ?? []) for (const title of file.titles) {
          latestByName.set(title, Math.max(latestByName.get(title) ?? 0, file.lastReadAt, fileDates.get(file.fileId) ?? 0));
        }
        const names = [...latestByName.keys()].sort((a, b) => latestByName.get(b)! - latestByName.get(a)!);
        const matches = retained.current.matches;
        const now = Date.now();
        for (const [name, match] of matches) {
          if (!latestByName.has(name) || match.expiresAt <= now) matches.delete(name);
        }
        const unresolved = names.filter((name) => !matches.has(name));
        const cached = await readCachedReadBookMetadata(ownerKey, unresolved);
        if (disposed) return;
        for (const [name, match] of cached) matches.set(name, match);
        const metadata = new Map([...matches].map(([name, match]) => [name, match.metadata]));
        const missing = unresolved.filter((name) => !cached.has(name));
        const buildRows = prepareReadBooks(sessions, archive);
        const known = buildRows(metadata);
        setBooks(known);
        setError(false);
        setFailedCount(0);
        const hasPreview = (works: ReadBook[], nextTitle: string) => (
          works.length >= MY_PAGE_DASHBOARD_BOOK_LIMIT
          && works[MY_PAGE_DASHBOARD_BOOK_LIMIT - 1].lastReadAt > latestByName.get(nextTitle)!
        );
        const needsMetadata = missing.length > 0 && (!preview || !hasPreview(known, missing[0]));
        setLoadingMetadata(needsMetadata);
        if (needsMetadata) {
          const metadataLoader = await import('../../lib/readBookMetadata');
          if (disposed) return;
          let failedBeforeBatch = 0;
          let resolved = known;
          let previewPublished = false;
          let hasNewMatch = false;
          const update = (result: { metadata: Map<string, PublicBookMetadata | null>; failed: Set<string> }, title: string, expiresAt?: number) => {
            if (disposed) return;
            const value = result.metadata.get(title);
            if (value !== undefined) {
              metadata.set(title, value);
              if (expiresAt !== undefined) matches.set(title, { metadata: value, expiresAt });
            }
            setFailedCount(failedBeforeBatch + result.failed.size);
            if (value) hasNewMatch = true;
            if (value !== undefined && renderTimer === undefined && (!preview || (hasNewMatch && !previewPublished))) {
              renderTimer = window.setTimeout(() => {
                renderTimer = undefined;
                if (disposed) return;
                const current = buildRows(metadata);
                if (preview) {
                  // A known alternate name can still be waiting for confirmation.
                  const existing = new Set(resolved.slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map((book) => book.rowKey ?? book.id));
                  if (!current.slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).some((book) => !existing.has(book.rowKey ?? book.id))) return;
                  previewPublished = true;
                }
                setBooks(current);
              }, preview ? 0 : 300);
            }
          };
          const options = { signal: controller.signal, onProgress: update, cacheOwnerKey: ownerKey };
          if (preview) {
            // Resolve recent titles in small batches until the dashboard has enough works.
            for (let start = 0; start < missing.length && !disposed; start += 8) {
              hasNewMatch = false;
              previewPublished = false;
              const result = await metadataLoader.loadReadBookMetadata(missing.slice(start, start + 8), options);
              if (disposed) break;
              window.clearTimeout(renderTimer);
              renderTimer = undefined;
              failedBeforeBatch += result.failed.size;
              if (result.metadata.size > 0) {
                resolved = buildRows(metadata);
                setBooks(resolved);
              }
              const nextTitle = missing[start + 8];
              if (nextTitle && hasPreview(resolved, nextTitle)) break;
            }
          } else {
            await metadataLoader.loadReadBookMetadata(missing, options);
            if (!disposed && renderTimer !== undefined) setBooks(buildRows(metadata));
          }
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        window.clearTimeout(renderTimer);
        renderTimer = undefined;
        if (!disposed) setLoadingMetadata(false);
        running = false;
        if (dirty) { dirty = false; void load(); }
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 350);
    };
    const unsubscribe = subscribeReadingStatisticsChanges(ownerKey, schedule);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY) schedule();
    };
    window.addEventListener('storage', onStorage);
    void load();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(renderTimer);
      window.removeEventListener('storage', onStorage);
      unsubscribe();
    };
  }, [archived, guest, ownerKey, preview, retry]);

  const visibleBooks = !guest && retained.current.owner === ownerKey ? books : null;
  const orderedBooks = useMemo(() => !visibleBooks || sort === 'recent'
    ? visibleBooks : [...visibleBooks].sort(readOrder[sort]), [sort, visibleBooks]);
  const status = <>
    {guest && <p className="text-sm opacity-60">로그인 후 동기화된 책이 여기에 표시됩니다.</p>}
    {!guest && (!visibleBooks || (loadingMetadata && visibleBooks.length === 0)) && !error && <p role="status" className="text-sm opacity-60">읽은 책을 불러오는 중…</p>}
    {error && <p role="alert" className="text-sm">읽은 책을 불러오지 못했습니다. <button type="button" className="text-accent-500" onClick={() => { setError(false); setRetry((value) => value + 1); }}>다시 시도</button></p>}
    {failedCount > 0 && <p role="alert" className="mb-3 text-sm">일부 도서 정보를 불러오지 못했습니다. <button type="button" className="text-accent-500" onClick={() => setRetry((value) => value + 1)}>다시 시도</button></p>}
    {onRetryCatalog && <p role="status" className="mb-3 text-sm">상세 링크를 확인하지 못했습니다. <button type="button" className="text-accent-500" onClick={onRetryCatalog}>다시 시도</button></p>}
    {reviewError && <p role="alert" className="mb-3 text-sm">{reviewError} <button type="button" className="text-accent-500" onClick={onRetryReviews}>평가 다시 불러오기</button></p>}
    {!error && !loadingMetadata && failedCount === 0 && visibleBooks?.length === 0 && <p className="text-sm opacity-60">도서 정보가 연결된 독서 기록이 없습니다.</p>}
  </>;
  if (onShowAll) {
    return <DashboardBookRow title="읽은 도서" books={visibleBooks ?? []} onShowAll={onShowAll} onOpenBook={onOpenBook} getDetailId={getDetailId} getBookKey={(book) => book.rowKey ?? book.id} coverLoading="direct-with-proxy-fallback">
      {status}
    </DashboardBookRow>;
  }

  return (
    <section aria-label="읽은 책">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">
          읽은 책{visibleBooks && visibleBooks.length > 0 && <span className="ml-2 text-xs font-normal opacity-55">{visibleBooks.length.toLocaleString()}권</span>}
        </h2>
        <ListSort label="읽은 책 정렬" value={sort} options={readSorts} onChange={setSort} />
      </div>
      {status}
      <div className="mypage-divided-list">
        {orderedBooks?.slice(0, visibleCount).map((book) => (
          <ReadBookRow key={book.rowKey ?? book.id} book={book} detailId={getDetailId(book)} onOpenBook={onOpenBook} rating={findReviewWork(accountIndex, book)?.rating ?? 0} />
        ))}
      </div>
      {Boolean(visibleBooks && visibleBooks.length > visibleCount) && <button type="button" onClick={() => setVisibleCount((count) => count + 20)} className={`mt-4 w-full ${secondaryAction}`}>더 보기</button>}
    </section>
  );
}
