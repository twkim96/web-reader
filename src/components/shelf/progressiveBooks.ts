export const SHELF_PAGE_SIZE = 50;

export const getNextShelfVisibleCount = (
  current: number,
  total: number,
  pageSize = SHELF_PAGE_SIZE,
) => Math.min(total, current + pageSize);
