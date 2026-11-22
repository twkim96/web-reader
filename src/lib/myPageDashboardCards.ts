import { MY_PAGE_DASHBOARD_BOOK_LIMIT } from './myPageSocial';

export type DashboardReviewCard = {
  id: string;
  title: string;
  coverTitle: string | null;
  coverUrl: string | null;
  rating: number;
};

export function dashboardReviewCards(reviews: readonly {
  workId: string; title?: string | null; coverUrl?: string | null; rating: number;
}[]): DashboardReviewCard[] {
  return reviews.slice(0, MY_PAGE_DASHBOARD_BOOK_LIMIT).map((review) => ({
    id: review.workId,
    title: review.title ?? review.workId,
    coverTitle: review.title ?? null,
    coverUrl: review.coverUrl ?? null,
    rating: review.rating,
  }));
}
