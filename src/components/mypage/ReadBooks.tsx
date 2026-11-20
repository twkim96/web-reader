'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Star } from 'lucide-react';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { getLocalReadingSessionsV11 } from '../../lib/localReadingStatistics';
import { formatReadingDuration } from '../../lib/readingStatistics';
import { readHiddenReadingStatisticsSessionIds, READING_STATISTICS_HIDDEN_SESSIONS_STORAGE_KEY } from '../../lib/readingStatisticsSessionVisibility';
import { subscribeReadingStatisticsChanges } from '../../lib/readingStatisticsWake';
import { buildReadBooks, selectSyncedReadingSessions, type ReadBook } from '../../lib/readBooks';
import { BOOK_REVIEW_TEXT_LIMIT, readBookReview, removeBookReview, saveBookReview, subscribeBookReviewChanges, type BookReview } from '../../lib/localBookReview';
import { findReviewWork, indexReviewWorks, type MyPageOwnReviews, type MyPageReview, type MyPageReviewDeletion } from '../../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../../lib/myPageSocialClient';
import { BookCover } from './BookCover';
import { BookDetailLink } from './BookDetailLink';
import type { PublicBookMetadata } from '../../lib/publicBookMetadata';

type Metrics = Pick<ReadBook, 'totalMs' | 'progressPercent'>;
const formatMetrics = ({ totalMs, progressPercent }: Metrics) => (
  `${formatReadingDuration(totalMs)} 읽음 · 최고 ${progressPercent.toFixed(1)}%`
);

const secondaryAction = 'min-h-10 shrink-0 rounded-full px-3 text-xs font-medium hover:bg-[color-mix(in_srgb,currentColor_5%,transparent)] hover:text-accent-500';

function ReadBookRow({ book, ownerKey, onOpenBook, accountReview }: {
  book: ReadBook;
  ownerKey: OwnerKey;
  onOpenBook: (book: ReadBook) => void;
  accountReview?: {
    value: MyPageReview | undefined;
    deletion: MyPageReviewDeletion | undefined;
    ready: boolean;
    change: (review: MyPageReview | null, workId: string) => void;
    refresh: () => void;
  };
}) {
  const [localReview, setReview] = useState<BookReview | null>(null);
  const review = accountReview ? accountReview.value : localReview;
  const [editing, setEditing] = useState(false);
  const [editingTarget, setEditingTarget] = useState<MyPageReview | MyPageReviewDeletion>();
  const editingAccountReview = editingTarget && 'rating' in editingTarget ? editingTarget : undefined;
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const busy = useRef(false);
  const scope = useRef(0);
  const cloud = Boolean(accountReview);

  useEffect(() => {
    if (cloud) return;
    let active = true;
    const scopeRef = scope;
    const generationRef = generation;
    const scopeId = ++scope.current;
    busy.current = false;
    setPending(false);
    const refresh = () => {
      const current = ++generation.current;
      readBookReview(ownerKey, book, localStorage).then((value) => {
        if (active && current === generation.current) setReview(value);
      }).catch(() => { if (active && current === generation.current) setFeedback('저장한 평가를 불러오지 못했습니다.'); });
    };
    refresh();
    const unsubscribe = subscribeBookReviewChanges(ownerKey, refresh);
    window.addEventListener('focus', refresh);
    return () => { active = false; if (scopeRef.current === scopeId) scopeRef.current++; generationRef.current++; unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [book, cloud, ownerKey]);

  const beginEdit = () => {
    setEditingTarget(accountReview?.value ?? accountReview?.deletion);
    setRating(review?.rating ?? 0);
    setComment(review?.comment ?? '');
    setFeedback('');
    setEditing(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const current = ++generation.current;
    const scopeId = scope.current;
    try {
      if (accountReview) {
        const data = await myPageRequest<{ review: MyPageReview }>({ action: 'review' }, {
          owner: ownerKey,
          body: {
            workId: editingTarget?.workId ?? book.id,
            revision: editingTarget?.revision ?? null,
            platformWorkKeys: editingTarget ? undefined : book.platformWorkKeys,
            rating,
            comment,
            fileIds: book.fileIds?.slice(0, 32) ?? [],
            readingSnapshot: book.fileIds?.length ? {
              totalMs: Math.round(book.totalMs),
              progressPercent: book.progressPercent,
            } : null,
          },
        });
        accountReview.change(data.review, editingTarget?.workId ?? book.id);
      } else {
        const value = await saveBookReview(ownerKey, book, rating, comment, localStorage);
        if (generation.current === current) setReview(value);
      }
      if (scope.current !== scopeId) return;
      setEditing(false);
      setFeedback('');
    } catch (error) {
      if (scope.current === scopeId) {
        if (error instanceof MyPageRequestError && error.status === 409) {
          setEditing(false);
          accountReview?.refresh();
        }
        setFeedback(cloud ? (error as Error).message : '평가를 저장하지 못했습니다.');
      }
    }
    finally { if (scope.current === scopeId) { busy.current = false; setPending(false); } }
  };

  const remove = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    const current = ++generation.current;
    const scopeId = scope.current;
    try {
      if (accountReview && editingAccountReview) {
        const { workId, revision } = editingAccountReview;
        await myPageRequest({ action: 'review' }, { owner: ownerKey, body: { workId, revision, remove: true } });
        accountReview.change(null, workId);
      } else if (!cloud) await removeBookReview(ownerKey, book, localStorage);
      if (scope.current !== scopeId) return;
      if (generation.current === current) setReview(null);
      setEditing(false);
      setFeedback('');
    } catch (error) {
      if (scope.current === scopeId) {
        if (error instanceof MyPageRequestError && error.status === 409) {
          setEditing(false);
          accountReview?.refresh();
        }
        setFeedback(cloud ? (error as Error).message : '평가를 지우지 못했습니다.');
      }
    }
    finally { if (scope.current === scopeId) { busy.current = false; setPending(false); } }
  };

  return (
    <article className="min-w-0">
      <div className="flex items-center">
        <BookDetailLink bookId={book.id} onOpen={() => onOpenBook(book)} label={book.title} className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg pr-3 sm:gap-4 sm:pr-4">
          <BookCover url={book.coverUrl} proxy />
          <div className="min-w-0 flex-1">
            <h3 className="line-clamp-2 text-sm font-semibold group-hover:text-accent-500">{book.title}</h3>
            <p className="mt-1.5 text-xs opacity-65">{formatMetrics(book)}</p>
          </div>
        </BookDetailLink>
        {!editing && <button type="button" onClick={beginEdit} disabled={accountReview ? !accountReview.ready : undefined} aria-label={`${book.title} 평가 ${review ? '수정' : '남기기'}`} className={`${secondaryAction} disabled:opacity-45`}>
          {review ? '평가 수정' : '평가 남기기'}
        </button>}
      </div>
      {review && !editing && (
        <div className="mt-2.5 pl-[60px] sm:pl-16">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1 font-semibold text-accent-500">
              <Star size={14} fill="currentColor" aria-hidden="true" />
              <span aria-label={`별점 ${review.rating}점`}>{review.rating}/5</span>
            </span>
            {review.totalMs !== null && review.progressPercent !== null && <span className="opacity-70">{formatMetrics({ totalMs: review.totalMs, progressPercent: review.progressPercent })}</span>}
          </div>
          {review.comment && <p className="mt-1.5 break-words text-sm">{review.comment}</p>}
        </div>
      )}
      {editing && (
        <form onSubmit={save} className="mt-3 space-y-3 sm:ml-16">
          <fieldset disabled={pending}><div role="group" aria-label="별점" className="flex flex-wrap gap-1">
            {[1, 2, 3, 4, 5].map((value) => (
              <button key={value} type="button" onClick={() => setRating(value)} aria-pressed={rating === value}
                aria-label={`${value}점`} className={`flex size-9 items-center justify-center rounded-full ${value <= rating ? 'text-accent-500' : 'opacity-55'}`}>
                <Star size={19} fill={value <= rating ? 'currentColor' : 'none'} aria-hidden="true" />
              </button>
            ))}
          </div>
          <input type="text" aria-label="한줄평 (선택)" placeholder="한줄평 (선택)" value={comment}
            onChange={(event) => setComment(event.target.value)} maxLength={BOOK_REVIEW_TEXT_LIMIT}
            className="h-10 w-full rounded-lg bg-[color-mix(in_srgb,currentColor_5%,transparent)] px-3 text-sm focus-visible:outline-2 focus-visible:outline-accent-500" />
          <div className="flex flex-wrap justify-end gap-2">
            {(accountReview ? editingAccountReview : review) && <button type="button" onClick={remove} className={`mr-auto ${secondaryAction}`}>평가 삭제</button>}
            <button type="button" onClick={() => { setEditing(false); setFeedback(''); }} className={secondaryAction}>취소</button>
            <button type="submit" disabled={rating === 0} className="min-h-10 rounded-full bg-accent-500 px-4 text-xs font-semibold text-white disabled:opacity-40">저장</button>
          </div></fieldset>
        </form>
      )}
      {feedback && <p role="alert" className="mt-2 text-xs text-accent-500">{feedback}</p>}
    </article>
  );
}

export function ReadBooks({ ownerKey, onShowAll, onOpenBook, accountStorage = false }: {
  ownerKey: OwnerKey;
  onShowAll?: () => void;
  onOpenBook: (book: ReadBook) => void;
  accountStorage?: boolean;
}) {
  const guest = isGuestOwner(ownerKey);
  const preview = Boolean(onShowAll);
  const [books, setBooks] = useState<ReadBook[] | null>(null);
  const [error, setError] = useState(false);
  const [loadingMetadata, setLoadingMetadata] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(20);
  const [failedCount, setFailedCount] = useState(0);
  const [accountReviews, setAccountReviews] = useState<MyPageOwnReviews | null>(null);
  const [refreshingAccountReviews, setRefreshingAccountReviews] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [accountRetry, setAccountRetry] = useState(0);
  const accountRequest = useRef(0);
  const accountIndex = useMemo(() => indexReviewWorks(accountReviews?.reviews ?? []), [accountReviews]);
  const deletionIndex = useMemo(() => indexReviewWorks(accountReviews?.deletions ?? []), [accountReviews]);
  useEffect(() => {
    if (!accountStorage || guest || preview) return;
    const controller = new AbortController();
    const refresh = () => {
      const generation = ++accountRequest.current;
      setRefreshingAccountReviews(true);
      void myPageRequest<MyPageOwnReviews>({ view: 'reviews' }, { owner: ownerKey, signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted && generation === accountRequest.current) {
            setAccountReviews(data); setAccountError('');
          }
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted && generation === accountRequest.current) setAccountError(error.message);
        })
        .finally(() => {
          if (!controller.signal.aborted && generation === accountRequest.current) setRefreshingAccountReviews(false);
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [accountStorage, accountRetry, guest, ownerKey, preview]);
  const changeAccountReview = (review: MyPageReview | null, oldId: string) => {
    accountRequest.current++;
    setAccountReviews((current) => {
      const others = (current?.reviews ?? []).filter((item) => item.workId !== oldId && item.workId !== review?.workId);
      return {
        reviews: review ? [{ ...review, aliases: [...new Set([oldId, ...(review.aliases ?? [])])] }, ...others] : others,
        deletions: current?.deletions ?? [],
      };
    });
    setAccountRetry((value) => value + 1);
  };
  const retained = useRef<{ owner: OwnerKey; metadata: Map<string, PublicBookMetadata | null> }>({ owner: ownerKey, metadata: new Map() });

  useEffect(() => {
    if (guest) return;
    const controller = new AbortController();
    if (retained.current.owner !== ownerKey) {
      retained.current = { owner: ownerKey, metadata: new Map() };
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
        const sessions = selectSyncedReadingSessions(stored, ownerKey, readHiddenReadingStatisticsSessionIds(ownerKey));
        const latestByName = new Map<string, number>();
        for (const session of sessions) {
          latestByName.set(session.bookTitle, Math.max(latestByName.get(session.bookTitle) ?? 0, session.endedAtClient));
        }
        const names = [...latestByName.keys()].sort((a, b) => latestByName.get(b)! - latestByName.get(a)!);
        const metadata = retained.current.metadata;
        for (const name of metadata.keys()) if (!latestByName.has(name)) metadata.delete(name);
        const missing = names.filter((name) => !metadata.has(name));
        const known = buildReadBooks(sessions, metadata);
        setBooks(known);
        setError(false);
        setFailedCount(0);
        const hasPreview = (works: ReadBook[], nextTitle: string) => (
          works.length >= 4 && works[3].lastReadAt >= latestByName.get(nextTitle)!
        );
        const needsMetadata = missing.length > 0 && (!preview || !hasPreview(known, missing[0]));
        setLoadingMetadata(needsMetadata);
        if (needsMetadata) {
          const metadataLoader = await import('../../lib/readBookMetadata');
          if (disposed) return;
          let failedBeforeBatch = 0;
          const update = (result: { metadata: Map<string, PublicBookMetadata | null>; failed: Set<string> }, title: string) => {
            if (disposed) return;
            const value = result.metadata.get(title);
            if (value !== undefined) metadata.set(title, value);
            setFailedCount(failedBeforeBatch + result.failed.size);
            if (!preview && value && renderTimer === undefined) {
              renderTimer = window.setTimeout(() => {
                renderTimer = undefined;
                if (!disposed) setBooks(buildReadBooks(sessions, metadata));
              }, 300);
            }
          };
          const options = { signal: controller.signal, onProgress: update };
          if (preview) {
            // Resolve recent titles in small batches until the dashboard has enough works.
            let resolved = known;
            for (let start = 0; start < missing.length && !disposed; start += 8) {
              const result = await metadataLoader.loadReadBookMetadata(missing.slice(start, start + 8), options);
              if (disposed) break;
              failedBeforeBatch += result.failed.size;
              if ([...result.metadata.values()].some(Boolean)) {
                resolved = buildReadBooks(sessions, metadata);
                setBooks(resolved);
              }
              const nextTitle = missing[start + 8];
              if (nextTitle && hasPreview(resolved, nextTitle)) break;
            }
          } else {
            await metadataLoader.loadReadBookMetadata(missing, options);
            if (!disposed && renderTimer !== undefined) setBooks(buildReadBooks(sessions, metadata));
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
  }, [guest, ownerKey, preview, retry]);

  const visibleBooks = !guest && retained.current.owner === ownerKey ? books : null;

  return (
    <section aria-label="읽은 책" className="mypage-section">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">읽은 책{!preview && visibleBooks && visibleBooks.length > 0 && <span className="ml-2 text-xs font-normal opacity-55">{visibleBooks.length.toLocaleString()}권</span>}</h2>
        {onShowAll && Boolean(visibleBooks?.length) && <button type="button" onClick={onShowAll} className="flex items-center gap-1 text-xs opacity-65">전체 보기<ArrowUpRight size={14} /></button>}
      </div>
      {guest && <p className="text-sm opacity-60">로그인 후 동기화된 책이 여기에 표시됩니다.</p>}
      {!guest && (!visibleBooks || loadingMetadata) && !error && <p role="status" className="text-sm opacity-60">읽은 책을 불러오는 중…</p>}
      {error && <p role="alert" className="text-sm">읽은 책을 불러오지 못했습니다. <button type="button" className="text-accent-500" onClick={() => { setError(false); setRetry((value) => value + 1); }}>다시 시도</button></p>}
      {failedCount > 0 && <p role="alert" className="mb-3 text-sm">일부 도서 정보를 불러오지 못했습니다. <button type="button" className="text-accent-500" onClick={() => setRetry((value) => value + 1)}>다시 시도</button></p>}
      {accountError && <p role="alert" className="mb-3 text-sm">{accountError} <button type="button" className="text-accent-500" onClick={() => setAccountRetry((value) => value + 1)}>평가 다시 불러오기</button></p>}
      {!error && !loadingMetadata && failedCount === 0 && visibleBooks?.length === 0 && <p className="text-sm opacity-60">도서 정보가 연결된 독서 기록이 없습니다.</p>}
      <div className="grid gap-4 sm:gap-5">
        {visibleBooks?.slice(0, preview ? 4 : visibleCount).map((book) => onShowAll ? (
          <BookDetailLink key={book.id} bookId={book.id} onOpen={() => onOpenBook(book)} className="flex min-w-0 items-center gap-3 text-left text-sm font-semibold hover:text-accent-500 sm:gap-4">
            <BookCover url={book.coverUrl} proxy />
            <span className="line-clamp-2">{book.title}</span>
          </BookDetailLink>
        ) : <ReadBookRow key={book.id} book={book} ownerKey={ownerKey} onOpenBook={onOpenBook} accountReview={accountStorage ? {
          value: findReviewWork(accountIndex, book),
          deletion: findReviewWork(deletionIndex, book),
          ready: accountReviews !== null && !refreshingAccountReviews && !accountError, change: changeAccountReview,
          refresh: () => setAccountRetry((value) => value + 1),
        } : undefined} />)}
      </div>
      {!onShowAll && Boolean(visibleBooks && visibleBooks.length > visibleCount) && <button type="button" onClick={() => setVisibleCount((count) => count + 20)} className={`mt-4 w-full ${secondaryAction}`}>더 보기</button>}
    </section>
  );
}
