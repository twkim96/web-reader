'use client';

import { useState } from 'react';
import type { OwnerKey } from '../lib/ownerIdentity';

type SortOptions<T extends string> = readonly (readonly [T, string])[];
type PrivateList = 'discover' | 'read' | 'wishlist' | 'reviews';
const sortPrefix = 'reader_mypage_sort_v1';
export const publicReviewSortKey = `${sortPrefix}:public-reviews`;

export function readMyPageSort<T extends string>(key: string, options: SortOptions<T>, fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return options.find(([value]) => value === stored)?.[0] ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveMyPageSort(key: string, sort: string) {
  try {
    window.localStorage.setItem(key, sort);
  } catch {
    // The selected sort still applies in the current view.
  }
}

export function useMyPageSort<T extends string>(
  owner: OwnerKey, list: PrivateList, options: SortOptions<T>, fallback: NoInfer<T>,
) {
  const key = `${sortPrefix}:${encodeURIComponent(owner)}:${list}`;
  const [selection, setSelection] = useState(() => ({ key, sort: readMyPageSort(key, options, fallback) }));
  const sort = selection.key === key ? selection.sort : readMyPageSort(key, options, fallback);

  const changeSort = (next: T) => {
    setSelection({ key, sort: next });
    saveMyPageSort(key, next);
  };

  return [sort, changeSort] as const;
}
