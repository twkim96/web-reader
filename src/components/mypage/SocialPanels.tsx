'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { OwnerKey } from '../../lib/ownerIdentity';
import {
  formatMyPageIdentity, hasPublicMyPage, publicReaderHref,
  type MyPageAccount, type MyPageIdentity, type MyPageVisibility,
} from '../../lib/myPageSocial';
import { myPageRequest } from '../../lib/myPageSocialClient';
import { readWishlist } from '../../lib/localWishlist';
import { listLocalBookReviews } from '../../lib/localBookReview';

const field = 'min-h-11 min-w-0 rounded-lg bg-[color-mix(in_srgb,currentColor_6%,transparent)] px-3 text-sm';
const button = 'min-h-11 rounded-full bg-accent-500 px-4 text-sm font-semibold text-white disabled:opacity-45';
const flags: Array<{ key: keyof MyPageVisibility; label: string }> = [
  { key: 'reviews', label: '별점 및 평가 공개' },
  { key: 'reading', label: '읽은 책 공개' },
  { key: 'wishlist', label: '위시리스트 공개' },
];

export function PeopleSearch() {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState<{ text: string }>();
  const [state, setState] = useState<{ people: MyPageIdentity[]; error: string | null }>();
  useEffect(() => {
    if (!submitted) return;
    const controller = new AbortController();
    void myPageRequest<{ people: MyPageIdentity[] }>({ view: 'people', q: submitted.text }, { signal: controller.signal })
      .then(({ people }) => { if (!controller.signal.aborted) setState({ people, error: null }); })
      .catch((error: Error) => { if (!controller.signal.aborted) setState({ people: [], error: error.message }); });
    return () => controller.abort();
  }, [submitted]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) return;
    setState(undefined);
    setSubmitted({ text: query.trim() });
  };
  return (
    <section className="mypage-section" aria-label="사람 검색">
      <h2 className="text-xl font-semibold">사람 검색</h2>
      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input className={`${field} flex-1`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="닉네임 또는 ID 코드" aria-label="닉네임 또는 ID 코드" maxLength={32} />
        <button type="submit" className={button} disabled={!query.trim()}>검색</button>
      </form>
      {submitted && !state && <p role="status" className="mt-4 text-sm opacity-70">검색 중…</p>}
      {state?.error && <p role="alert" className="mt-4 text-sm text-accent-500">{state.error}</p>}
      {state && !state.error && (state.people.length
        ? <ul className="mt-4 space-y-1">{state.people.map((person) => (
            <li key={person.code}><a href={publicReaderHref(person.code)} className="block rounded-lg px-2 py-2.5 text-sm hover:text-accent-500">{formatMyPageIdentity(person)}</a></li>
          ))}</ul>
        : <p className="mt-4 text-sm opacity-70">공개된 프로필을 찾지 못했습니다.</p>)}
    </section>
  );
}

export function MyPageSharingSettings({ owner, onWishlistImported }: { owner: OwnerKey; onWishlistImported: () => void }) {
  const [account, setAccount] = useState<MyPageAccount>();
  const [draft, setDraft] = useState<MyPageAccount>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [legacy, setLegacy] = useState<{
    workIds: string[];
    reviews: Array<{ workIds: string[]; platformWorkKeys: string[]; rating: number; comment: string }>;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void myPageRequest<MyPageAccount>({ view: 'account' }, { owner, signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) return;
      setAccount(data);
      setDraft(data);
    }).catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [attempt, owner]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || pending) return;
    setPending(true);
    setError('');
    setFeedback('');
    try {
      const data = await myPageRequest<MyPageAccount>({ action: 'account' }, { owner, body: draft });
      setAccount(data);
      setDraft(data);
      setLegacy(null);
      setFeedback('공개 설정을 저장했습니다.');
    } catch (error) { setError((error as Error).message); }
    finally { setPending(false); }
  };
  const preview = async () => {
    if (pending) return;
    setPending(true);
    setFeedback('');
    setError('');
    try {
      const workIds = readWishlist(owner, localStorage).map(({ book }) => book.id);
      const reviews = (await listLocalBookReviews(owner, localStorage)).map(({ workIds, platformWorkKeys, review }) => ({
        workIds: platformWorkKeys.length ? [] : workIds, platformWorkKeys, rating: review.rating, comment: review.comment,
      }));
      setLegacy(workIds.length + reviews.length ? { workIds, reviews } : null);
      if (!workIds.length && !reviews.length) setFeedback('이 브라우저에 가져올 위시리스트나 평가가 없습니다.');
    } catch { setError('이 브라우저의 저장 내용을 불러오지 못했습니다.'); }
    finally { setPending(false); }
  };
  const importLegacy = async () => {
    if (!account || !legacy || pending) return;
    setPending(true);
    setError('');
    try {
      let current = 0;
      let unavailable = 0;
      let kept = 0;
      for (let start = 0; start < legacy.workIds.length; start += 8) {
        const result = await myPageRequest<{ current: number; unavailable: number }>({ action: 'import-wishlist' }, {
          owner, body: { accountRevision: account.revision, workIds: legacy.workIds.slice(start, start + 8) },
        });
        current += result.current;
        unavailable += result.unavailable;
      }
      for (let start = 0; start < legacy.reviews.length; start += 2) {
        const result = await myPageRequest<{ current: number; unavailable: number; kept: number }>({ action: 'import-reviews' }, {
          owner, body: { accountRevision: account.revision, reviews: legacy.reviews.slice(start, start + 2) },
        });
        current += result.current;
        unavailable += result.unavailable;
        kept += result.kept;
      }
      setLegacy(null);
      setFeedback([
        current ? '작품을 확인한 항목의 가져오기를 완료했습니다.' : '',
        kept ? `계정에 평가나 삭제 기록이 있는 ${kept}건은 그대로 두었습니다.` : '',
        unavailable ? `작품을 확인하지 못한 ${unavailable}건은 건너뛰었습니다.` : '',
      ].filter(Boolean).join(' '));
      onWishlistImported();
    } catch (error) {
      setError((error as Error).message);
      onWishlistImported();
    } finally { setPending(false); }
  };

  return (
    <section className="mypage-section space-y-4" aria-label="프로필 및 공개 설정">
      <h2 className="text-xl font-semibold">프로필 및 공개 설정</h2>
      {!draft && !error && <p role="status" className="text-sm opacity-70">설정을 불러오는 중…</p>}
      {error && <p role="alert" className="text-sm text-accent-500">{error} <button type="button" className="underline" onClick={() => { setError(''); setAttempt((count) => count + 1); }}>서버 설정 다시 불러오기</button></p>}
      {draft && account && <>
        <form className="max-w-md space-y-4" onSubmit={save}>
          <fieldset disabled={pending} className="space-y-4">
            <label className="grid gap-1.5 text-sm">닉네임<input className={field} value={draft.nickname} onChange={(event) => setDraft({ ...draft, nickname: event.target.value })} maxLength={40} required /></label>
            <p className="text-sm">ID 코드 <strong className="ml-2 tracking-wide">{account.code}</strong></p>
            <div className="space-y-1">
              {flags.map(({ key, label }) => <label key={key} className="flex min-h-10 items-center justify-between gap-4 text-sm">
                {label}<input type="checkbox" checked={draft.visibility[key]} onChange={(event) => setDraft({ ...draft, visibility: { ...draft.visibility, [key]: event.target.checked } })} className="size-4 accent-[var(--accent-500)]" />
              </label>)}
            </div>
            <p className="text-xs opacity-70">평가를 공개하면 작품 상세에 닉네임, 별점, 한줄평과 확인된 독서 시간·진행률이 표시됩니다. 공개를 끄면 내 별점이 작품 평균과 평가 개수에서 빠집니다.</p>
            {draft.visibility.reading && <p className="text-xs opacity-70">읽은 책 공개에는 계정에 동기화된 책이 포함됩니다. 이 기기에서만 숨긴 독서 기록도 포함될 수 있습니다.</p>}
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" className={button}>{pending ? '처리 중…' : '설정 저장'}</button>
              {hasPublicMyPage(account.visibility) && <a href={publicReaderHref(account.code)} className="text-sm text-accent-500">내 공개 마이페이지</a>}
            </div>
          </fieldset>
        </form>
        <div className="space-y-2">
          <button type="button" disabled={pending} onClick={() => void preview()} className="min-h-10 text-sm font-medium text-accent-500">이 브라우저의 위시리스트와 평가 가져오기</button>
          {legacy && <div className="space-y-2">
            <p className="text-sm">위시리스트 {legacy.workIds.length}권과 평가 {legacy.reviews.length}건 중 작품을 확인한 항목을 계정에 복사합니다. 브라우저의 저장 내용은 그대로 보관합니다. {legacy.workIds.length > 0 && account.visibility.wishlist && '가져온 위시리스트도 공개됩니다. '}{legacy.reviews.length > 0 && account.visibility.reviews && '가져온 평가도 공개되고 평균에 반영됩니다.'}</p>
            <button type="button" disabled={pending} className={button} onClick={() => void importLegacy()}>가져오기 확인</button>
          </div>}
        </div>
      </>}
      {feedback && <p role="status" className="text-sm opacity-75">{feedback}</p>}
    </section>
  );
}
