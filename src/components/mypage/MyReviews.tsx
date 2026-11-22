'use client';

import { useEffect, useRef, useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import { REVIEW_LIST_SORTS, sortReviewList, type MyPageReview } from '../../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../../lib/myPageSocialClient';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { useMyPageSort } from '../../hooks/useMyPageSort';
import { useMyPageReviewList } from '../../hooks/useMyPageList';
import { fullReviewListCache } from '../../lib/myPageListCache';
import { ownerRuntime } from '../../lib/ownerRuntime';
import { dashboardReviewCards } from '../../lib/myPageDashboardCards';
import { BookCover } from './BookCover';
import { BookDetailLink } from './BookDetailLink';
import { DashboardBookRow } from './DashboardBookRow';
import { ListSort } from './ListSort';

export function MyReviews({ owner, onOpenBook, onShowAll, paused = false }: {
  owner: OwnerKey;
  onOpenBook: (id: string) => void;
  onShowAll?: () => void;
  paused?: boolean;
}) {
  const guest = isGuestOwner(owner);
  const preview = Boolean(onShowAll);
  const { data, error, refresh, writeVersion } = useMyPageReviewList(owner, !guest && !paused, preview);
  const reviews = data?.reviews;
  const session = ownerRuntime.capture();
  const [sort, setSort] = useMyPageSort(owner, 'reviews', REVIEW_LIST_SORTS, 'recent');
  const [confirmation, setConfirmation] = useState<MyPageReview>();
  const [mutationError, setMutationError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const activeMutation = mutation;
    return () => activeMutation.current?.abort();
  }, [owner]);

  const remove = async () => {
    if (!confirmation || mutation.current || writeVersion % 2 !== 0 || session?.ownerKey !== owner || !ownerRuntime.isCurrent(session)) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setMutationError('');
    setFeedback('');
    const { workId, revision } = confirmation;
    try {
      await myPageRequest({ action: 'review' }, { owner, signal: controller.signal, body: { workId, revision, remove: true } });
      if (controller.signal.aborted || !ownerRuntime.isCurrent(session)) return;
      fullReviewListCache.update(session, (current) => ({
        ...current, reviews: current.reviews.filter((item) => item.workId !== workId),
      }));
      void refresh();
      setConfirmation(undefined);
      setFeedback('평가를 삭제했습니다.');
    } catch (error) {
      if (controller.signal.aborted || !ownerRuntime.isCurrent(session)) return;
      if (error instanceof MyPageRequestError && error.status === 409) {
        setConfirmation(undefined);
        void refresh();
      }
      setMutationError((error as Error).message);
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const problem = error || mutationError;
  const reviewCount = reviews?.length;
  const status = <>
      {problem && <p role="alert" className="text-sm text-accent-500">{problem} <button type="button" className="underline" onClick={() => { setMutationError(''); void refresh(); }}>다시 불러오기</button></p>}
      {feedback && <p role="status" className="text-sm opacity-75">{feedback}</p>}
      {guest && <p className="text-sm opacity-65">로그인 후 남긴 평가를 볼 수 있습니다.</p>}
      {reviewCount === undefined && !problem && !guest && <p role="status" className="text-sm opacity-65">평가를 불러오는 중…</p>}
      {reviewCount === 0 && <p className="text-sm opacity-65">남긴 평가가 없습니다.</p>}
  </>;
  if (onShowAll) {
    const books = reviews ? dashboardReviewCards(reviews) : [];
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
              <button type="button" className="grid size-10 shrink-0 place-items-center rounded-full text-accent-500 disabled:opacity-40" aria-label={`${review.title ?? review.workId} 평가 삭제`} onClick={() => setConfirmation(review)} disabled={busy || writeVersion % 2 !== 0}><Trash2 size={17} aria-hidden="true" /></button>
            </div>
            {confirmation?.workId === review.workId && <div className="flex flex-wrap items-center gap-3 text-sm">
              <p>이 평가를 삭제할까요?</p>
              <button type="button" className="min-h-9 rounded-full px-3 text-accent-500 disabled:opacity-40" disabled={busy || writeVersion % 2 !== 0} onClick={() => void remove()}>{busy ? '삭제 중…' : '삭제 확인'}</button>
              <button type="button" className="min-h-9 px-3 opacity-70" disabled={busy || writeVersion % 2 !== 0} onClick={() => setConfirmation(undefined)}>취소</button>
            </div>}
          </li>
        ))}
      </ul>}
    </section>
  );
}
