export const LEGACY_DRIVE_TOKEN_KEY = 'google_drive_token';
export const LEGACY_DRIVE_EXPIRY_KEY = 'google_drive_token_expiry';
export const DRIVE_TOKEN_SESSION_KEY = 'google_drive_session_v2';

export type DriveTokenSnapshot = {
  token: string;
  expiresAt: number;
  sessionId: string;
};

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

  restore(snapshot: unknown, now = Date.now()) {
    if (
      typeof snapshot !== 'object'
      || snapshot === null
      || !('token' in snapshot)
      || typeof snapshot.token !== 'string'
      || snapshot.token.length === 0
      || !('expiresAt' in snapshot)
      || typeof snapshot.expiresAt !== 'number'
      || !Number.isFinite(snapshot.expiresAt)
      || snapshot.expiresAt <= now
      || !('sessionId' in snapshot)
      || typeof snapshot.sessionId !== 'string'
      || snapshot.sessionId.length === 0
    ) {
      this.clear();
      return false;
    }
    this.token = snapshot.token;
    this.expiresAt = snapshot.expiresAt;
    this.sessionId = snapshot.sessionId;
    return true;
  }

  snapshot(): DriveTokenSnapshot | null {
    if (!this.token || !this.sessionId || this.expiresAt <= 0) return null;
    return {
      token: this.token,
      expiresAt: this.expiresAt,
      sessionId: this.sessionId,
    };
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
