import { Star } from 'lucide-react';

export function ReviewStar({ rating, position, size }: { rating: number; position: number; size: number }) {
  const full = rating >= position;
  const half = rating === position - 0.5;
  return (
    <span aria-hidden="true" className="pointer-events-none relative inline-flex shrink-0">
      <Star size={size} fill={full ? 'currentColor' : 'none'} className={full ? 'text-accent-500' : 'opacity-55'} />
      {half && <Star size={size} fill="currentColor" className="absolute inset-0 text-accent-500 [clip-path:inset(0_50%_0_0)]" />}
    </span>
  );
}
