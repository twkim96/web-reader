'use client';

import { useEffect, useRef, useState } from 'react';
import { myPageRequest } from '../lib/myPageSocialClient';
import type { MyPageOwnReviews, MyPageReview } from '../lib/myPageSocial';
import type { OwnerKey } from '../lib/ownerIdentity';

export function useMyPageReviews(ownerKey: OwnerKey, enabled: boolean) {
  const [data, setData] = useState<MyPageOwnReviews>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [changeVersion, setChangeVersion] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = () => {
      const current = ++generation.current;
      setLoading(true);
      void myPageRequest<MyPageOwnReviews>({ view: 'reviews' }, { owner: ownerKey, signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted || generation.current !== current) return;
          setData(result);
          setError('');
        }).catch((failure: Error) => {
          if (!controller.signal.aborted && generation.current === current) setError(failure.message);
        }).finally(() => {
          if (!controller.signal.aborted && generation.current === current) setLoading(false);
        });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      window.removeEventListener('focus', load);
    };
  }, [attempt, enabled, ownerKey]);

  const refresh = () => setAttempt((value) => value + 1);
  const change = (review: MyPageReview | null, oldId: string) => {
    generation.current++;
    setData((current) => {
      const others = (current?.reviews ?? []).filter((item) => item.workId !== oldId && item.workId !== review?.workId);
      return {
        reviews: review ? [{ ...review, aliases: [...new Set([oldId, ...(review.aliases ?? [])])] }, ...others] : others,
        deletions: current?.deletions ?? [],
      };
    });
    setChangeVersion((value) => value + 1);
    refresh();
  };

  return { data, error, ready: Boolean(data && !loading && !error), refresh, change, changeVersion };
}
