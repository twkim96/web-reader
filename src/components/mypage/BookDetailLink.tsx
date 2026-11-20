import type { MouseEvent, ReactNode } from 'react';
import { bookDetailHref } from '../../lib/bookDetail';

export function BookDetailLink({ bookId, focusReview, onOpen, children, className, label }: {
  bookId: string;
  focusReview?: boolean;
  onOpen: () => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen();
  };
  return <a href={bookDetailHref(bookId, focusReview)} onClick={handleClick} aria-label={label} className={className}>{children}</a>;
}
