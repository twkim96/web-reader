export const normalizeHangulSearchText = (value: string) => value
  .normalize('NFKC')
  .replace(/\s+/g, '')
  .toLowerCase();

export const isHangulInitialQuery = (query: string) => /^[\u1100-\u1112]+$/u.test(query);

export const getHangulInitials = (value: string) =>
  value.replace(/[가-힣]/g, (syllable) => syllable.normalize('NFD')[0]);
