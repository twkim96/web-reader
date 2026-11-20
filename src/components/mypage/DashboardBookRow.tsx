'use client';

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useMouseDragScroll } from '../../hooks/useMouseDragScroll';
import { MY_PAGE_DASHBOARD_BOOK_LIMIT } from '../../lib/myPageSocial';
import { BookCover } from './BookCover';
import { BookDetailLink } from './BookDetailLink';

const showAllClass = '-mr-2 flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-xs opacity-65 hover:text-accent-500 hover:opacity-100';
const showAllContent = <>전체 보기 <ChevronRight size={16} aria-hidden="true" /></>;

export function DashboardBookRow<T extends { id: string; title: string; coverUrl: string | null }>({
  title, books, onOpenBook, onShowAll, showAllHref, renderDetail, proxy, children,
}: {
  title: string;
  books: readonly T[];
  onOpenBook: (book: T) => void;
  onShowAll?: () => void;
  showAllHref?: string;
  renderDetail?: (book: T) => ReactNode;
  proxy?: boolean;
  children?: ReactNode;
}) {
  const drag = useMouseDragScroll();

  return (
    <section aria-label={title} className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{title}</h2>
        {showAllHref ? <Link href={showAllHref} prefetch={false} aria-label={`${title} 전체 보기`} className={showAllClass}>{showAllContent}</Link>
          : onShowAll && <button type="button" onClick={onShowAll} aria-label={`${title} 전체 보기`} className={showAllClass}>{showAllContent}</button>}
      </div>
      {children && <div className="mt-2">{children}</div>}
      {books.length > 0 && (
        <ul data-dashboard-book-row tabIndex={0} aria-label={`${title} 가로 목록`} {...drag}
          onDragStart={(event) => event.preventDefault()}
          className="mt-3 flex gap-3 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none] sm:gap-4 [&::-webkit-scrollbar]:hidden data-[mouse-dragging=true]:cursor-grabbing data-[mouse-dragging=true]:select-none">
          {books.slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map((book) => (
            <li key={book.id} className="w-[var(--mypage-cover-width,clamp(5.5rem,29vw,7.5rem))] shrink-0">
              <BookDetailLink bookId={book.id} onOpen={() => onOpenBook(book)} label={book.title}
                className="group block rounded-lg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500">
                <BookCover url={book.coverUrl} large proxy={proxy} />
                <span className="mt-2 line-clamp-2 break-words text-sm font-semibold leading-snug group-hover:text-accent-500">{book.title}</span>
                {renderDetail?.(book)}
              </BookDetailLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
