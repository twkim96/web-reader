'use client';

import { useState } from 'react';
import { fullReviewListCache } from '../lib/myPageListCache';
import type { MyPageReview } from '../lib/myPageSocial';
import type { OwnerKey } from '../lib/ownerIdentity';
import { ownerRuntime } from '../lib/ownerRuntime';
import { useMyPageReviewList } from './useMyPageList';

export function useMyPageReviews(ownerKey: OwnerKey, enabled: boolean) {
  const { data, error, refresh, writeVersion } = useMyPageReviewList(ownerKey, enabled);
  const [changeVersion, setChangeVersion] = useState(0);
  const session = ownerRuntime.capture();
  const change = (review: MyPageReview | null, oldId: string) => {
    if (session?.ownerKey !== ownerKey || !ownerRuntime.isCurrent(session)) return;
    fullReviewListCache.update(session, (current) => ({
      reviews: [
        ...(review ? [{ ...review, aliases: [...new Set([oldId, ...(review.aliases ?? [])])] }] : []),
        ...current.reviews.filter((item) => item.workId !== oldId && item.workId !== review?.workId),
      ],
      deletions: current.deletions.filter((item) => item.workId !== review?.workId),
    }));
    setChangeVersion((value) => value + 1);
    // Reload deletion revisions and any server-enriched fields through the shared request.
    void refresh();
  };

  return { data, error, ready: data !== undefined && writeVersion % 2 === 0, refresh, change, changeVersion };
}
