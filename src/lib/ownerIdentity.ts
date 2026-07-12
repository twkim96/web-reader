export type AuthOwnerKey = `firebase:${string}` | `guest:${string}`;
export type LibraryScopeKey = `drive:${string}` | 'library:local';
export type OwnerKey = `${AuthOwnerKey}|${LibraryScopeKey}`;

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

export const makeDriveScopeKey = (permissionId: string): LibraryScopeKey =>
  `drive:${requireIdentifier(permissionId, 'Drive permission id')}`;

export const makeOwnerKey = (
  authOwnerKey: AuthOwnerKey,
  libraryScopeKey: LibraryScopeKey,
): OwnerKey => `${authOwnerKey}|${libraryScopeKey}`;

export const getLibraryScopeId = (libraryScopeKey: LibraryScopeKey) => {
  if (libraryScopeKey === 'library:local') return 'local';
  return encodeURIComponent(libraryScopeKey.slice('drive:'.length));
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
