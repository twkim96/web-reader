import { getBookTitleFromFileName } from './bookFormats.ts';
import { extractReadableTitle } from '../vendor/fileCheckTitleNormalizer.js';

// Reuse cover lookup's readable cleanup without changing book identity or metadata.
const summarizedTitles = new Map<string, string>();
const CACHE_LIMIT = 1000;

export const getBookDisplayTitle = (name: string, summarize = true): string => {
  const originalTitle = getBookTitleFromFileName(name);
  if (!summarize) return originalTitle;
  const cached = summarizedTitles.get(originalTitle);
  if (cached !== undefined) return cached;
  const title = extractReadableTitle(originalTitle).trim() || originalTitle;
  if (summarizedTitles.size >= CACHE_LIMIT) {
    summarizedTitles.delete(summarizedTitles.keys().next().value!);
  }
  summarizedTitles.set(originalTitle, title);
  return title;
};
