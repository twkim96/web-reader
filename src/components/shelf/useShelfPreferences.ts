import { useState } from 'react';
import { ShelfSortMode, ShelfViewMode } from './bookUtils';

const VIEW_MODE_KEY = 'shelf_viewMode';
const SORT_MODE_KEY = 'shelf_sortMode';

const getStoredViewMode = (): ShelfViewMode => {
  if (typeof window === 'undefined') return 'grid';
  const saved = localStorage.getItem(VIEW_MODE_KEY);
  return saved === 'grid' || saved === 'list' ? saved : 'grid';
};

const getStoredSortMode = (): ShelfSortMode => {
  if (typeof window === 'undefined') return 'recent';
  const saved = localStorage.getItem(SORT_MODE_KEY);
  return saved === 'alpha' || saved === 'recent' || saved === 'popularity'
    ? saved
    : 'recent';
};

export const useShelfPreferences = () => {
  const [viewMode, setViewMode] = useState<ShelfViewMode>(getStoredViewMode);
  const [sortMode, setSortMode] = useState<ShelfSortMode>(getStoredSortMode);

  const toggleViewMode = () => {
    setViewMode(current => {
      const next = current === 'grid' ? 'list' : 'grid';
      localStorage.setItem(VIEW_MODE_KEY, next);
      return next;
    });
  };

  const updateSortMode = (next: ShelfSortMode) => {
    localStorage.setItem(SORT_MODE_KEY, next);
    setSortMode(next);
  };

  return {
    viewMode,
    sortMode,
    toggleViewMode,
    setSortMode: updateSortMode,
  };
};
