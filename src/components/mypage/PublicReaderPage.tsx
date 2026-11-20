'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, Star } from 'lucide-react';
import { getStoredViewerSettings } from '../../hooks/useViewerSettings';
import { bookDetailHref } from '../../lib/bookDetail';
import { formatMyPageIdentity, type MyPageVisibility, type PublicMyPage, type PublicProfileBook } from '../../lib/myPageSocial';
import { myPageRequest } from '../../lib/myPageSocialClient';
import { getThemeAccentColor, getThemeCssVariables } from '../../lib/themeUtils';
import { ACCENT_PALETTE } from '../../lib/constants';
import { BookCover } from './BookCover';

export function PublicReaderPage({ code }: { code: string }) {
  const [profile, setProfile] = useState<PublicMyPage | null>(null);
  const [theme, setTheme] = useState<React.CSSProperties>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<keyof MyPageVisibility>();
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    setError('');
    setPending(undefined);
    try {
      const result = await myPageRequest<PublicMyPage>({ view: 'profile', code });
      if (current === generation.current) setProfile(result);
    } catch (error) {
      if (current === generation.current) { setProfile(null); setError((error as Error).message); }
    }
  }, [code]);
  useEffect(() => {
    const settings = getStoredViewerSettings();
    const accent = ACCENT_PALETTE[getThemeAccentColor(settings)] ?? ACCENT_PALETTE.rose;
    setTheme({ ...getThemeCssVariables(settings), '--accent-500': accent[500] } as React.CSSProperties);
  }, []);
  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    window.addEventListener('focus', refresh);
    const requests = generation;
    return () => { requests.current++; window.removeEventListener('focus', refresh); };
  }, [reload]);

  const more = async (section: keyof MyPageVisibility, offset: number) => {
    if (pending) return;
    setPending(section);
    const current = ++generation.current;
    try {
      const result = await myPageRequest<PublicMyPage>({ view: 'profile', code, section, offset: String(offset) });
      if (current !== generation.current) return;
      setProfile((old) => {
        if (!old) return result;
        const append = <T,>(before: T[] | undefined, after: T[] | undefined) => [...(before ?? []), ...(after ?? [])];
        return {
          identity: result.identity, visibility: result.visibility,
          wishlist: result.visibility.wishlist ? append(old.wishlist, result.wishlist) : undefined,
          reviews: result.visibility.reviews ? append(old.reviews, result.reviews) : undefined,
          next: { ...old.next, [section]: result.next?.[section] ?? null },
        };
      });
    } catch {
      if (current === generation.current) void reload();
    } finally {
      if (current === generation.current) setPending(undefined);
    }
  };

  const section = <T extends PublicProfileBook>(
    key: keyof MyPageVisibility, title: string, books: T[] | undefined, detail?: (book: T) => ReactNode,
  ) => {
    if (!profile?.visibility[key]) return null;
    const offset = profile.next?.[key];
    return (
      <section className="mypage-section space-y-4" aria-label={title}>
        <h2 className="text-lg font-semibold">{title}</h2>
        {books?.length ? <ul className="mypage-divided-list">
          {books.map((book) => <li key={book.workId}>
            <Link href={`/${bookDetailHref(book.workId)}`} className="group flex min-w-0 items-center gap-3 rounded-lg">
              <BookCover url={book.coverUrl} />
              <div className="min-w-0">
                <h3 className="break-words text-sm font-semibold group-hover:text-accent-500">{book.title}</h3>
                {detail?.(book)}
              </div>
            </Link>
          </li>)}
        </ul> : <p className="text-sm opacity-65">표시할 책이 없습니다.</p>}
        {typeof offset === 'number' && <button type="button" onClick={() => void more(key, offset)} disabled={Boolean(pending)} className="min-h-10 text-sm text-accent-500 disabled:opacity-50">더 보기</button>}
      </section>
    );
  };
  return (
    <div className="min-h-dvh" style={{ ...theme, backgroundColor: 'var(--viewer-theme-bg)', color: 'var(--viewer-theme-text)' }}>
      <main className="mx-auto max-w-3xl space-y-5 px-5 py-7 sm:px-8">
        <Link href="/#mypage/browse" className="flex w-fit items-center gap-2 text-sm opacity-75 hover:opacity-100"><ArrowLeft size={17} />둘러보기</Link>
        {error ? <p role="alert" className="mypage-section text-sm">{error} <button type="button" className="text-accent-500 underline" onClick={() => void reload()}>다시 시도</button></p>
        : !profile ? <p role="status" className="mypage-section text-sm">공개 마이페이지를 불러오는 중…</p>
        : <>
          <h1 className="break-words text-2xl font-semibold">{formatMyPageIdentity(profile.identity)}</h1>
          {section('wishlist', '위시리스트', profile.wishlist)}
          {section('reviews', '별점 및 평가', profile.reviews, ({ rating, comment }) => (
            <div className="mt-1 space-y-1">
              <span className="flex items-center gap-1 text-xs font-semibold text-accent-500"><Star size={13} fill="currentColor" aria-hidden="true" />{rating}/5</span>
              {comment && <p className="break-words text-sm opacity-75">{comment}</p>}
            </div>
          ))}
        </>}
      </main>
    </div>
  );
}
