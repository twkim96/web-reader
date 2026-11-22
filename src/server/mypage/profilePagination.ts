import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { isBookDetailId } from '../../lib/bookDetail';
import type { MyPageBrowseSection, ReviewListSort } from '../../lib/myPageSocial';

export const PROFILE_PAGE_SIZE = 30;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const keys = new WeakMap<Firestore, Promise<Buffer>>();
const keyRef = (db: Firestore) => db.doc('serverSecretsV1/myPageProfileCursor');
type SortKey = [ratingOrder: number, time: string, workId: string];
export type ProfileCursor = {
  code: string;
  section: MyPageBrowseSection;
  sort: ReviewListSort;
  revision: number;
  key: SortKey;
};

function validateKey(value: unknown) {
  if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Invalid public profile pagination key');
  return value;
}

function profileCursorKey(db: Firestore) {
  const cached = keys.get(db);
  if (cached) return cached;
  // All server instances use the same key. Client access to this path is denied by Rules.
  const ref = keyRef(db);
  const pending = ref.get().then((snapshot) => (
    snapshot.exists ? validateKey(snapshot.get('key')) : db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (current.exists) return validateKey(current.get('key'));
      const key = randomBytes(32);
      transaction.create(ref, { key });
      return key;
    })
  )).catch((error) => {
    keys.delete(db);
    throw error;
  });
  keys.set(db, pending);
  return pending;
}

async function readProfileCursorKey(db: Firestore) {
  const cached = keys.get(db);
  if (cached) return cached;
  const snapshot = await keyRef(db).get();
  if (!snapshot.exists) return null;
  const key = validateKey(snapshot.get('key'));
  if (!keys.has(db)) keys.set(db, Promise.resolve(key));
  return key;
}

export async function parseProfileCursor(db: Firestore, value: string): Promise<ProfileCursor | null> {
  if (value.length > 2300 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const token = Buffer.from(value, 'base64url');
  if (token.length <= NONCE_BYTES + TAG_BYTES || token.toString('base64url') !== value) return null;
  const key = await readProfileCursorKey(db);
  if (!key) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, token.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(token.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    const cleartext = Buffer.concat([decipher.update(token.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]);
    const [version, code, section, sort, revision, ratingOrder, time, workId] =
      JSON.parse(cleartext.toString('utf8'));
    if (version !== 1 || typeof code !== 'string' || (section !== 'reviews' && section !== 'wishlist')
      || (sort !== 'recent' && sort !== 'rating-asc' && sort !== 'rating-desc')
      || !Number.isSafeInteger(revision) || !Number.isFinite(ratingOrder) || typeof time !== 'string'
      || !isBookDetailId(workId)) return null;
    return { code, section, sort, revision, key: [ratingOrder, time, workId] };
  } catch {
    return null;
  }
}

async function issueProfileCursor(db: Firestore, scope: Omit<ProfileCursor, 'key'>, key: SortKey) {
  const secret = await profileCursorKey(db);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secret, nonce);
  const value = JSON.stringify([1, scope.code, scope.section, scope.sort, scope.revision, ...key]);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function compareKeys(a: SortKey, b: SortKey) {
  return a[0] - b[0] || Number(a[1] < b[1]) - Number(a[1] > b[1]) || a[2].localeCompare(b[2])
    || Number(a[2] > b[2]) - Number(a[2] < b[2]);
}

export async function profileCursorPage<T>(
  db: Firestore, records: readonly T[], keyFor: (record: T) => SortKey,
  scope: Omit<ProfileCursor, 'key'>, boundary?: SortKey,
) {
  const ordered = records.map((record) => ({ record, key: keyFor(record) }))
    .filter(({ key }) => !boundary || compareKeys(key, boundary) > 0)
    .sort((a, b) => compareKeys(a.key, b.key));
  const page = ordered.slice(0, PROFILE_PAGE_SIZE);
  const nextKey = ordered.length > page.length ? page.at(-1)?.key : undefined;
  const next = nextKey ? await issueProfileCursor(db, scope, nextKey) : null;
  return { entries: page.map(({ record }) => record), next };
}

export function legacyProfilePage<T>(records: readonly T[], offset: number) {
  const end = offset + PROFILE_PAGE_SIZE;
  return { entries: records.slice(offset, end), next: records.length > end ? end : null };
}
