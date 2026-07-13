export type AuthOwnerKey = `firebase:${string}` | `guest:${string}`;
export type LibraryScopeKey = 'library:local';
export type OwnerKey = `${AuthOwnerKey}|${LibraryScopeKey}`;

// Books cached in IndexedDB belong to this browser profile, not to Firebase or
// to whichever Google Drive account happens to be connected.
export const DEVICE_CONTENT_OWNER_KEY: OwnerKey = 'guest:device-library|library:local';

// Realtime reading state is owned only by the Firebase account. Drive scopes
// remain valid for book inventory, downloads, and device-local file caches.
export const FIREBASE_SYNC_SCOPE_KEY: LibraryScopeKey = 'library:local';

export const GUEST_INSTALL_ID_KEY = 'web_reader_guest_install_id';

const requireIdentifier = (value: string, label: string) => {
  const normalized = value.trim();
  if (!normalized || normalized.includes('|')) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
};

export const makeFirebaseOwnerKey = (uid: string): AuthOwnerKey =>
  `firebase:${requireIdentifier(uid, 'Firebase uid')}`;

export const makeGuestOwnerKey = (installId: string): AuthOwnerKey =>
  `guest:${requireIdentifier(installId, 'Guest install id')}`;

export const makeOwnerKey = (
  authOwnerKey: AuthOwnerKey,
  libraryScopeKey: LibraryScopeKey,
): OwnerKey => `${authOwnerKey}|${libraryScopeKey}`;

export const getSyncOwnerKey = (ownerKey: OwnerKey): OwnerKey => {
  const { authOwnerKey } = splitOwnerKey(ownerKey);
  return makeOwnerKey(authOwnerKey, FIREBASE_SYNC_SCOPE_KEY);
};

export const isGuestOwner = (ownerKey: OwnerKey) => ownerKey.startsWith('guest:');

export const splitOwnerKey = (ownerKey: OwnerKey) => {
  const separator = ownerKey.indexOf('|');
  if (separator <= 0) throw new Error('Owner key is invalid');
  return {
    authOwnerKey: ownerKey.slice(0, separator) as AuthOwnerKey,
    libraryScopeKey: ownerKey.slice(separator + 1) as LibraryScopeKey,
  };
};

export const getOrCreateGuestInstallId = (storage: Pick<Storage, 'getItem' | 'setItem'>) => {
  const existing = storage.getItem(GUEST_INSTALL_ID_KEY)?.trim();
  if (existing) return existing;
  const installId = crypto.randomUUID();
  storage.setItem(GUEST_INSTALL_ID_KEY, installId);
  return installId;
};
