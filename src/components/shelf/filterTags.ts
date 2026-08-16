export const SHELF_TAG_PAGE_SIZE = 15;

export const getNextShelfTagCount = (current: number, total: number) => (
  Math.min(total, Math.max(SHELF_TAG_PAGE_SIZE, current + SHELF_TAG_PAGE_SIZE))
);
