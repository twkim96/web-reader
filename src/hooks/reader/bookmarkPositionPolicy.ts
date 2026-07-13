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
    // Foliate's range CFI has a measurable rectangle when reopening it.
    // A collapsed anchor CFI can resolve only as far as the section and leave
    // Chromium at the first page of the chapter.
    bookmarkCfi: currentCfi || anchorCfi,
    progressCfi: currentCfi,
    anchorCfi,
  };
};

export const getAutoBookmarkName = (previewText: string) => (
  previewText.replace(/^이전\s*위치\s*:\s*/, '').trim() || '북마크'
);
