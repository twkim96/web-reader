export type BookmarkPosition = {
  bookmarkCfi: string;
  progressCfi: string;
  anchorCfi: string;
};

export const getBookmarkPosition = (
  currentCfi: string,
  currentAnchorCfi: string,
): BookmarkPosition => {
  const anchorCfi = currentAnchorCfi || currentCfi;
  return {
    bookmarkCfi: anchorCfi,
    progressCfi: currentCfi,
    anchorCfi,
  };
};

export const getAutoBookmarkName = (previewText: string) => (
  previewText.replace(/^이전\s*위치\s*:\s*/, '').trim() || '북마크'
);
