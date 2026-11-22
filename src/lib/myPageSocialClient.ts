import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import type { MyPageReview, MyPageSavedBook } from './myPageSocial';
import { fullReviewListCache, previewReviewListCache, wishlistListCache } from './myPageListCache';
import { ownerRuntime, type OwnerSnapshot } from './ownerRuntime';
import { isMyPagePerformanceEnabled } from './myPagePerformance';

export class MyPageRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 409 ? '다른 기기에서 변경했습니다. 새로고침하고 다시 시도해 주세요.'
      : status === 401 ? '다시 로그인해 주세요.'
      : status === 404 ? '공개 프로필이나 작품을 찾지 못했습니다.'
      : status === 400 ? '입력한 내용을 확인해 주세요.'
      : '서버와 연결하지 못했습니다. 다시 시도해 주세요.');
  }
}

export async function myPageRequest<T>(params: Record<string, string>, options: {
  owner?: OwnerKey;
  body?: object;
  signal?: AbortSignal;
} = {}): Promise<T> {
  const { owner, body } = options;
  const session = owner ? ownerRuntime.capture() : null;
  const action = params.action;
  const caches = action === 'wishlist' || action === 'import-wishlist' ? [wishlistListCache]
    : action === 'review' || action === 'import-reviews' ? [fullReviewListCache, previewReviewListCache]
      : [];
  const finishWrites = owner && body ? caches.map((cache) => cache.beginWrite(owner)) : [];
  let wishlistAcknowledged = false;
  try {
    const response = await requestMyPage<T>(params, options, session);
    if (action === 'wishlist' && body && session && session.ownerKey === owner) {
      const saved = response as MyPageSavedBook;
      wishlistListCache.update(session, ({ entries }) => ({
        entries: [saved, ...entries.filter(({ item }) => item.workId !== saved.item.workId)],
      }));
      wishlistAcknowledged = true;
    }
    return response;
  } catch (error) {
    if (session && session.ownerKey === owner && !options.signal?.aborted
      && error instanceof MyPageRequestError && error.status === 401) {
      for (const cache of [wishlistListCache, fullReviewListCache, previewReviewListCache]) {
        cache.clear(session, error.message);
      }
    }
    throw error;
  } finally {
    finishWrites.forEach((finish) => finish?.(wishlistAcknowledged));
  }
}

async function requestMyPage<T>(
  params: Record<string, string>,
  options: { owner?: OwnerKey; body?: object; signal?: AbortSignal },
  session: OwnerSnapshot | null,
): Promise<T> {
  const headers = new Headers();
  if (options.owner) {
    if (isGuestOwner(options.owner)) throw new MyPageRequestError(401);
    const { auth } = await import('./firebase');
    const user = auth.currentUser;
    if (!user || `firebase:${user.uid}|library:local` !== options.owner) throw new MyPageRequestError(401);
    headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
    if (auth.currentUser?.uid !== user.uid || (session && !ownerRuntime.isCurrent(session))) {
      throw new MyPageRequestError(401);
    }
    options.signal?.throwIfAborted();
  }
  if (options.body) headers.set('Content-Type', 'application/json');
  const query = new URLSearchParams(params);
  if (!options.body && options.owner && (params.view === 'wishlist' || params.view === 'reviews')
    && isMyPagePerformanceEnabled()) {
    query.set('timing', '1');
  }
  const response = await fetch(`/api/mypage?${query}`, {
    method: options.body ? 'POST' : 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new MyPageRequestError(response.status);
  return response.json() as Promise<T>;
}

export async function saveMyPageReview(owner: OwnerKey, fields: object): Promise<MyPageReview> {
  const body = { ...fields, saveId: crypto.randomUUID() };
  const session = ownerRuntime.capture();
  const retryDelays = [350, 1_000];
  for (let attempt = 0; ; attempt++) {
    if (session && !ownerRuntime.isCurrent(session)) throw new MyPageRequestError(401);
    try {
      const { review } = await myPageRequest<{ review: MyPageReview }>({ action: 'review' }, {
        owner, body, signal: AbortSignal.timeout(8_000),
      });
      return review;
    } catch (error) {
      const delay = retryDelays[attempt];
      const transient = error instanceof TypeError
        || (error instanceof DOMException && error.name === 'TimeoutError')
        || (error instanceof MyPageRequestError && (error.status === 408 || error.status >= 500));
      if (delay === undefined || !transient) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
