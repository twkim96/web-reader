'use client';

import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { MyPageOwnReviews, MyPageReview } from '../../lib/myPageSocial';
import { myPageRequest, MyPageRequestError } from '../../lib/myPageSocialClient';
import type { OwnerKey } from '../../lib/ownerIdentity';

export function MyReviews({ owner }: { owner: OwnerKey }) {
  const [reviews, setReviews] = useState<MyPageReview[]>();
  const [confirmation, setConfirmation] = useState<MyPageReview>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void myPageRequest<MyPageOwnReviews>({ view: 'reviews' }, { owner, signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setReviews(result.reviews);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [attempt, owner]);

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
      setReviews((items) => items?.filter((item) => item.workId !== workId));
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

  return (
    <section className="mypage-section space-y-4" aria-label="내 평가">
      <h2 className="text-xl font-semibold">내 평가</h2>
      {error && <p role="alert" className="text-sm text-accent-500">{error} <button type="button" className="underline" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>다시 불러오기</button></p>}
      {feedback && <p role="status" className="text-sm opacity-75">{feedback}</p>}
      {!reviews && !error && <p role="status" className="text-sm opacity-65">평가를 불러오는 중…</p>}
      {reviews?.length === 0 && <p className="text-sm opacity-65">남긴 평가가 없습니다.</p>}
      {reviews && reviews.length > 0 && <ul className="space-y-5">
        {reviews.map((review) => (
          <li key={review.workId} className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <h3 className="break-words text-sm font-semibold">{review.title ?? review.workId}</h3>
                <p className="text-xs font-semibold text-accent-500">별점 {review.rating}/5</p>
                {review.comment && <p className="break-words text-sm opacity-75">{review.comment}</p>}
              </div>
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
