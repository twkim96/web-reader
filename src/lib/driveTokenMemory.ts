export const LEGACY_DRIVE_TOKEN_KEY = 'google_drive_token';
export const LEGACY_DRIVE_EXPIRY_KEY = 'google_drive_token_expiry';

type TokenStorage = Pick<Storage, 'removeItem'>;

export const clearLegacyDriveTokenArtifacts = (
  local: TokenStorage,
  session: TokenStorage,
) => {
  for (const storage of [local, session]) {
    storage.removeItem(LEGACY_DRIVE_TOKEN_KEY);
    storage.removeItem(LEGACY_DRIVE_EXPIRY_KEY);
  }
};

export const hasLegacyOAuthFragment = (hash: string) => {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  return params.has('access_token') || params.has('error');
};

export class DriveTokenMemory {
  private token: string | null = null;
  private expiresAt = 0;
  private sessionId: string | null = null;

  save(
    token: string,
    expiresInSeconds: number,
    now = Date.now(),
    createSessionId = () => crypto.randomUUID(),
  ) {
    this.token = token;
    this.expiresAt = now + Math.max(0, expiresInSeconds - 30) * 1000;
    this.sessionId = createSessionId();
    return this.sessionId;
  }

  clear() {
    this.token = null;
    this.expiresAt = 0;
    this.sessionId = null;
  }

  getToken() {
    return this.token;
  }

  getSessionId() {
    return this.sessionId;
  }

  isValid(now = Date.now()) {
    return Boolean(this.token && now < this.expiresAt);
  }
}

export class DriveTokenRequestSingleFlight {
  private pending: Promise<void> | null = null;

  run(start: () => Promise<void>) {
    if (this.pending) return this.pending;
    // GIS popup APIs must run in the original user activation stack. Deferring
    // start() to a microtask makes Safari and some Android browsers block it.
    const pending = start().finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
}
