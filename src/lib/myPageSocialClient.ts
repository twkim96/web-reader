import { isGuestOwner, type OwnerKey } from './ownerIdentity';
import type { MyPageReview } from './myPageSocial';

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
  const headers = new Headers();
  if (options.owner) {
    if (isGuestOwner(options.owner)) throw new MyPageRequestError(401);
    const { auth } = await import('./firebase');
    const user = auth.currentUser;
    if (!user || `firebase:${user.uid}|library:local` !== options.owner) throw new MyPageRequestError(401);
    headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
    if (auth.currentUser?.uid !== user.uid) throw new MyPageRequestError(401);
  }
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/mypage?${new URLSearchParams(params)}`, {
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
  const retryDelays = [350, 1_000];
  for (let attempt = 0; ; attempt++) {
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
