'use client';

import { useRef, useState, type FormEvent, type Ref } from 'react';
import { BOOK_REVIEW_TEXT_LIMIT } from '../../lib/publicBookReviews';
import type { MyPageReview, MyPageReviewDeletion } from '../../lib/myPageSocial';
import { myPageRequest, saveMyPageReview } from '../../lib/myPageSocialClient';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { ReviewStar } from './ReviewStar';

type Rating = Pick<MyPageReview, 'rating' | 'comment'>;
type Draft = Rating & { target?: MyPageReview | MyPageReviewDeletion };
const secondaryAction = 'min-h-10 rounded-full px-3 text-xs font-medium hover:bg-current/5 hover:text-accent-500';

export function BookReviewEditor({
  ownerKey, workId, platformWorkKeys, fileIds, readingSnapshot, review, deletion, ready,
  loadingHistory, error, refresh, change, headingRef,
}: {
  ownerKey: OwnerKey;
  workId: string;
  platformWorkKeys: readonly string[];
  fileIds: readonly string[];
  readingSnapshot: { totalMs: number; progressPercent: number } | null;
  review?: MyPageReview;
  deletion?: MyPageReviewDeletion;
  ready: boolean;
  loadingHistory: boolean;
  error: string;
  refresh: () => void;
  change: (review: MyPageReview | null, oldId: string) => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const guest = isGuestOwner(ownerKey);
  const [draft, setDraft] = useState<Draft>();
  const [saving, setSaving] = useState<Rating>();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const busy = useRef(false);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || busy.current || !ready) return;
    const { rating, comment, target } = draft;
    const fields = { rating, comment: comment.trim() };
    const targetId = target?.workId ?? workId;
    busy.current = true;
    setPending(true);
    setSaving(fields);
    setDraft(undefined);
    setFeedback('');
    try {
      const saved = await saveMyPageReview(ownerKey, {
        ...fields, workId: targetId, revision: target?.revision ?? null,
        platformWorkKeys: target ? undefined : platformWorkKeys,
        fileIds: fileIds.slice(0, 32), readingSnapshot,
      });
      change(saved, targetId);
    } catch (failure) {
      refresh();
      setFeedback(failure instanceof Error ? failure.message : '평가를 저장하지 못했습니다.');
    } finally {
      busy.current = false;
      setPending(false);
      setSaving(undefined);
    }
  };

  const remove = async () => {
    const target = draft?.target;
    if (!target || !('rating' in target) || busy.current || !ready) return;
    busy.current = true;
    setPending(true);
    setFeedback('');
    try {
      await myPageRequest({ action: 'review' }, { owner: ownerKey, body: { workId: target.workId, revision: target.revision, remove: true } });
      change(null, target.workId);
      setDraft(undefined);
    } catch (failure) {
      refresh();
      setDraft(undefined);
      setFeedback(failure instanceof Error ? failure.message : '평가를 지우지 못했습니다.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const displayed = draft ?? saving ?? review;
  const rating = displayed?.rating ?? 0;

  return (
    <section className="mypage-section" aria-labelledby="my-book-review-title">
      <h2 id="my-book-review-title" ref={headingRef} tabIndex={-1}
        className="scroll-mt-[calc(4rem+env(safe-area-inset-top))] text-lg font-semibold focus:outline-none sm:scroll-mt-16">내 평가</h2>
      {guest ? <p className="mt-2 text-sm opacity-65">로그인 후 평가를 남길 수 있습니다.</p>
        : error ? <p role="alert" className="mt-2 text-sm text-accent-500">{error} <button type="button" onClick={refresh} className="underline">다시 시도</button></p>
        : !ready || loadingHistory ? <p role="status" className="mt-2 text-sm opacity-65">평가를 불러오는 중…</p>
        : null}
      {!guest && <>
        <div role="group" aria-label={rating ? `별점 ${rating}점` : '별점 미평가'} className="mt-2 flex">
          {[1, 2, 3, 4, 5].map((position) => (
            <div key={position} className={`relative grid size-9 place-items-center ${!ready || pending || loadingHistory ? 'opacity-50' : ''}`}>
              <ReviewStar position={position} rating={rating} size={21} />
              <div className="absolute inset-0 flex">
                {[position - 0.5, position].map((value) => (
                  <button key={value} type="button" aria-label={`${value}점`} aria-pressed={value === rating}
                    title={`${value}점`} disabled={!ready || pending || loadingHistory} onClick={() => {
                      setDraft({ rating: value, comment: draft?.comment ?? review?.comment ?? '', target: draft ? draft.target : review ?? deletion });
                      setFeedback('');
                    }}
                    className="w-1/2 rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500" />
                ))}
              </div>
            </div>
          ))}
        </div>
        {draft ? (
          <form onSubmit={save} className="mt-2 max-w-lg space-y-2">
            <input type="text" aria-label="한줄평 (선택)" placeholder="한줄평 (선택)" value={draft.comment}
              onChange={(event) => setDraft({ ...draft, comment: event.target.value })} maxLength={BOOK_REVIEW_TEXT_LIMIT}
              disabled={pending} className="h-10 w-full rounded-lg px-3 text-sm ring-1 ring-inset ring-current/15 focus-visible:outline-2 focus-visible:outline-accent-500" />
            <div className="flex flex-wrap justify-end gap-2">
              {draft.target && 'rating' in draft.target && <button type="button" onClick={remove} disabled={pending || !ready} className={`mr-auto ${secondaryAction}`}>평가 삭제</button>}
              <button type="button" disabled={pending} className={secondaryAction} onClick={() => setDraft(undefined)}>취소</button>
              <button type="submit" disabled={pending || !ready || loadingHistory} className="min-h-10 rounded-full bg-accent-500 px-4 text-xs font-semibold text-white disabled:opacity-40">저장</button>
            </div>
          </form>
        ) : displayed?.comment && <p className="mt-2 break-words text-sm">{displayed.comment}</p>}
      </>}
      {feedback && <p role="alert" className="mt-2 text-sm text-accent-500">{feedback}</p>}
    </section>
  );
}
