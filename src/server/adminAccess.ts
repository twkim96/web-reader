import { createHash } from 'node:crypto';

// The manually backfilled pilot of the production Firebase project.
const productionPilotHash = '03a7ef17c0b4359cab1d7a9b18d37f5776e228e0b4cef98334b1a8b9aa9e1a36';

export const adminAccountHash = (uid: string) => createHash('sha256').update(uid).digest('hex');

export function configuredAdminHash() {
  const uid = process.env.WEB_READER_ADMIN_UID?.trim();
  if (uid) return adminAccountHash(uid);
  const isProductionProject = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === 'web-novel-viewer';
  return process.env.VERCEL_ENV === 'production' && isProductionProject ? productionPilotHash : '';
}
