'use client';

import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { publicReaderHref, type MyPageBrowseSection, type PublicBrowsePage } from '../../lib/myPageSocial';
import { myPageRequest } from '../../lib/myPageSocialClient';
import { isGuestOwner, type OwnerKey } from '../../lib/ownerIdentity';
import { DashboardBookRow } from './DashboardBookRow';

export function PublicBrowse({ section, owner, onOpenBook }: {
  section: MyPageBrowseSection;
  owner: OwnerKey;
  onOpenBook: (id: string) => void;
}) {
  const [result, setResult] = useState<PublicBrowsePage>();
  const [request, setRequest] = useState<{ cursor: string | null }>({ cursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const params: Record<string, string> = { view: 'browse', section };
    if (request.cursor) params.cursor = request.cursor;
    void myPageRequest<PublicBrowsePage>(params, {
      owner: isGuestOwner(owner) ? undefined : owner,
      signal: controller.signal,
    }).then((page) => {
      if (controller.signal.aborted) return;
      setResult((current) => {
        if (!request.cursor || !current) return page;
        const groups = new Map(current.groups.map((group) => [group.reader.code, group]));
        for (const group of page.groups) groups.set(group.reader.code, group);
        return { groups: [...groups.values()], next: page.next };
      });
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [owner, request, section]);

  const load = (cursor: string | null) => {
    setLoading(true);
    setError('');
    setRequest({ cursor });
  };

  return <div className="space-y-7 sm:space-y-9">
    {result?.groups.map(({ reader, books }) => (
      <DashboardBookRow key={reader.code}
        title={section === 'reviews' ? `${reader.nickname}님이 평점을 남긴 도서` : `${reader.nickname}님이 담은 도서`}
        books={books.map((book) => ({ ...book, id: book.workId }))}
        onOpenBook={({ id }) => onOpenBook(id)}
        showAllHref={publicReaderHref(reader.code)}
        renderDetail={({ rating, comment }) => rating !== undefined && (
          <div className="mt-1 space-y-1">
            <span className="flex items-center gap-1 text-xs font-semibold text-accent-500" aria-label={`별점 ${rating}점`}>
              <Star size={13} fill="currentColor" aria-hidden="true" />{rating}/5
            </span>
            {comment && <span className="line-clamp-2 break-words text-xs opacity-65">{comment}</span>}
          </div>
        )} />
    ))}
    {loading && <p role="status" className="text-sm opacity-60">도서를 불러오는 중…</p>}
    {error && <p role="alert" className="text-sm text-accent-500">{error} <button type="button" className="underline" onClick={() => load(request.cursor)}>다시 불러오기</button></p>}
    {!loading && !error && !result?.next && result?.groups.length === 0 && <p className="text-sm opacity-60">공개된 도서가 없습니다.</p>}
    {!loading && !error && result?.next && <button type="button" onClick={() => load(result.next)}
      className="min-h-11 px-2 text-sm font-medium text-accent-500">더 보기</button>}
  </div>;
}
