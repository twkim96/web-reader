'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Star, Trash2 } from 'lucide-react';
import { REVIEW_LIST_SORTS, sortReviewList, type MyPageOwnReviews, type MyPageReview } from '../../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../../lib/myPageSocialClient';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { useMyPageSort } from '../../hooks/useMyPageSort';
import { useMyPageDashboardCards } from '../../hooks/useMyPageDashboardCards';
import { dashboardReviewCache, dashboardReviewCards } from '../../lib/myPageDashboardCache';
import { BookCover } from './BookCover';
import { BookDetailLink } from './BookDetailLink';
import { DashboardBookRow } from './DashboardBookRow';
import { ListSort } from './ListSort';

export function MyReviews({ owner, onOpenBook, onShowAll, changeVersion, paused = false }: {
  owner: OwnerKey;
  onOpenBook: (id: string) => void;
  onShowAll?: () => void;
  changeVersion?: number;
  paused?: boolean;
}) {
  const guest = isGuestOwner(owner);
  const preview = Boolean(onShowAll);
  const cachedReviews = useMyPageDashboardCards(dashboardReviewCache, owner, preview && !guest);
  // Odd versions are a write in progress. Even versions advance when the last
  // write settles, including a failed save or an import without a UI callback.
  const writeVersion = useSyncExternalStore(
    dashboardReviewCache.subscribe,
    () => preview && !guest ? dashboardReviewCache.writeVersion(owner) : 0,
    () => 0,
  );
  const [reviews, setReviews] = useState<MyPageReview[]>();
  const [sort, setSort] = useMyPageSort(owner, 'reviews', REVIEW_LIST_SORTS, 'recent');
  const [confirmation, setConfirmation] = useState<MyPageReview>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(() => {
    if (guest || paused || writeVersion % 2 !== 0) return;
    const controller = new AbortController();
    request.current = controller;
    const params: Record<string, string> = { view: 'reviews' };
    if (preview) params.preview = '1';
    const cache = preview ? dashboardReviewCache.beginRead(owner) : undefined;
    void myPageRequest<MyPageOwnReviews>(params, { owner, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (cache && !cache(dashboardReviewCards(result.reviews))) return;
        setReviews(result.reviews);
        setError('');
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          if (error instanceof MyPageRequestError && error.status === 401) {
            cache?.(undefined);
            setReviews(undefined);
          }
          setError(error.message);
        }
      });
    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [attempt, changeVersion, guest, owner, paused, preview, writeVersion]);

  useEffect(() => {
    if (guest || paused) return;
    let active = true;
    let queued = false;
    const resume = () => {
      if (document.visibilityState === 'hidden') return;
      request.current?.abort();
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (active) setAttempt((value) => value + 1);
      });
    };
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      active = false;
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [guest, owner, paused]);

  useEffect(() => {
    const activeMutation = mutation;
    return () => activeMutation.current?.abort();
  }, [owner]);

  const remove = async () => {
    if (!confirmation || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError('');
    setFeedback('');
    const { workId, revision } = confirmation;
    try {
      await myPageRequest({ action: 'review' }, { owner, signal: controller.signal, body: { workId, revision, remove: true } });
      if (controller.signal.aborted) return;
      request.current?.abort();
      setReviews((items) => items?.filter((item) => item.workId !== workId));
      setAttempt((value) => value + 1);
      setConfirmation(undefined);
      setFeedback('평가를 삭제했습니다.');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MyPageRequestError && error.status === 409) {
        setConfirmation(undefined);
        setAttempt((value) => value + 1);
      }
      setError((error as Error).message);
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const reviewCount = reviews?.length ?? cachedReviews?.length;
  const status = <>
      {error && <p role="alert" className="text-sm text-accent-500">{error} <button type="button" className="underline" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>다시 불러오기</button></p>}
      {feedback && <p role="status" className="text-sm opacity-75">{feedback}</p>}
      {guest && <p className="text-sm opacity-65">로그인 후 남긴 평가를 볼 수 있습니다.</p>}
      {reviewCount === undefined && !error && !guest && <p role="status" className="text-sm opacity-65">평가를 불러오는 중…</p>}
      {reviewCount === 0 && <p className="text-sm opacity-65">남긴 평가가 없습니다.</p>}
  </>;
  if (onShowAll) {
    const books = reviews ? dashboardReviewCards(reviews) : cachedReviews ?? [];
    return <DashboardBookRow title="평점을 남긴 도서" books={books} onShowAll={guest ? undefined : onShowAll}
      onOpenBook={({ id }) => onOpenBook(id)} coverLoading="direct-with-proxy-fallback"
      renderDetail={({ rating }) => <span className="mt-1 flex items-center gap-1 text-xs text-accent-500" aria-label={`별점 ${rating}점`}>
        <Star size={13} fill="currentColor" aria-hidden="true" /> {rating}/5
      </span>}>
      {status}
    </DashboardBookRow>;
  }

  return (
    <section className="space-y-4" aria-label="내 평가">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">내 평가</h2>
        <ListSort label="내 평가 정렬" value={sort} options={REVIEW_LIST_SORTS} onChange={setSort} />
      </div>
      {status}
      {reviews && reviews.length > 0 && <ul className="mypage-divided-list">
        {sortReviewList(reviews, sort).map((review) => (
          <li key={review.workId} className="mypage-book-list-item space-y-2">
            <div className="flex items-center justify-between gap-2">
              <BookDetailLink bookId={review.workId} onOpen={() => onOpenBook(review.workId)}
                className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg sm:gap-4">
                <BookCover url={review.coverUrl ?? null} identity={review.workId} title={review.title} coverLoading="direct-with-proxy-fallback" />
                <div className="min-w-0 space-y-1">
                  <h3 className="break-words text-sm font-semibold group-hover:text-accent-500">{review.title ?? review.workId}</h3>
                  <p className="text-xs font-semibold text-accent-500">별점 {review.rating}/5</p>
                  {review.comment && <p className="break-words text-sm opacity-75">{review.comment}</p>}
                </div>
              </BookDetailLink>
              <button type="button" className="grid size-10 shrink-0 place-items-center rounded-full text-accent-500 disabled:opacity-40" aria-label={`${review.title ?? review.workId} 평가 삭제`} onClick={() => setConfirmation(review)} disabled={busy}><Trash2 size={17} aria-hidden="true" /></button>
            </div>
            {confirmation?.workId === review.workId && <div className="flex flex-wrap items-center gap-3 text-sm">
              <p>이 평가를 삭제할까요?</p>
              <button type="button" className="min-h-9 rounded-full px-3 text-accent-500 disabled:opacity-40" disabled={busy} onClick={() => void remove()}>{busy ? '삭제 중…' : '삭제 확인'}</button>
              <button type="button" className="min-h-9 px-3 opacity-70" disabled={busy} onClick={() => setConfirmation(undefined)}>취소</button>
            </div>}
          </li>
        ))}
      </ul>}
    </section>
  );
}
