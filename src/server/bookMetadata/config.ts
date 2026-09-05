import { readBoundedBody } from '../boundedFetch.ts';

export const BOOK_METADATA_LIMITS = {
  bodyBytes: 8_192,
  responseBytes: 2_000_000,
  platformTimeoutMs: 8_000,
  overallTimeoutMs: 22_000,
  cacheMs: 7 * 24 * 60 * 60 * 1_000,
  leaseMs: 30_000,
  aliasCooldownMs: 60_000,
  dailyUserLimit: 20,
} as const;

export type AuthenticatedSession = {
  fetch(url: URL, init?: RequestInit): Promise<Response>;
};

export interface PlatformAuthProvider {
  isConfigured(): boolean;
  withSession<T>(work: (session: AuthenticatedSession) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export const novelpiaCredentialsConfigured = (env: NodeJS.ProcessEnv = process.env) => Boolean(
  env.NOVELPIA_EMAIL?.trim() && env.NOVELPIA_PASSWORD,
);

const cookiesFrom = (response: Response) => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
  return values.flatMap((value) => value.split(/,(?=\s*[^;,]+=)/)).map((value) => value.split(';', 1)[0].trim()).filter(Boolean);
};

class NovelpiaPasswordAuthProvider implements PlatformAuthProvider {
  isConfigured() { return novelpiaCredentialsConfigured(); }

  async withSession<T>(work: (session: AuthenticatedSession) => Promise<T>, signal?: AbortSignal) {
    const email = process.env.NOVELPIA_EMAIL?.trim();
    const password = process.env.NOVELPIA_PASSWORD;
    if (!email || !password) throw new Error('NovelPia authentication is not configured');
    const cookies = new Map<string, string>();
    const request = async (url: URL, init: RequestInit = {}) => {
      if (url.protocol !== 'https:' || url.hostname !== 'novelpia.com') throw new Error('NovelPia auth URL is not allowed');
      const response = await fetch(url, {
        ...init,
        signal: signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init.signal,
        cache: 'no-store',
        redirect: 'error',
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
          Referer: 'https://novelpia.com/',
          ...(cookies.size ? { Cookie: [...cookies.values()].join('; ') } : {}),
          ...init.headers,
        },
      });
      if (new URL(response.url).hostname !== 'novelpia.com') throw new Error('NovelPia auth redirect is not allowed');
      cookiesFrom(response).forEach((cookie) => cookies.set(cookie.split('=', 1)[0], cookie));
      if (!response.ok) throw new Error(`NovelPia auth HTTP ${response.status}`);
      return response;
    };
    const readText = async (response: Response) => new TextDecoder().decode(
      await readBoundedBody(response, BOOK_METADATA_LIMITS.responseBytes),
    );
    await readText(await request(new URL('https://novelpia.com/login')));
    const captcha = JSON.parse(await readText(await request(new URL('https://novelpia.com/proc/login_captcha?mode=get_captcha')))) as Record<string, unknown>;
    if (String(captcha.status) === '200' && captcha.result === true) throw new Error('NovelPia CAPTCHA is required');
    const form = new URLSearchParams({ redirectrurl: '', email, wd: password });
    await readText(await request(new URL('https://novelpia.com/proc/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://novelpia.com' },
      body: form,
    }));
    const adult = (await readText(await request(new URL('https://novelpia.com/proc/member_adt_mode'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Origin: 'https://novelpia.com' },
      body: new URLSearchParams({ option: 'on' }),
    }))).trim().replace(/^"|"$/g, '');
    if (adult !== 'OK') throw new Error(adult === 'auth' ? 'NovelPia adult verification is required' : 'NovelPia login was not verified');
    try {
      return await work({ fetch: (url, init) => request(new URL(url), init) });
    } finally {
      cookies.clear();
    }
  }
}

export const createNovelpiaAuthProvider = (): PlatformAuthProvider | null => (
  novelpiaCredentialsConfigured() ? new NovelpiaPasswordAuthProvider() : null
);
