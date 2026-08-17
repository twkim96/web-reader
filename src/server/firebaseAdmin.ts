import 'server-only';

import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const credential = () => {
  const raw = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return applicationDefault();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Firebase Admin credential is invalid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Firebase Admin credential is invalid');
  }
  return cert(value as Parameters<typeof cert>[0]);
};

const app = () => getApps()[0] ?? initializeApp({
  credential: credential(),
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
});

export const getAdminAuth = () => getAuth(app());
export const getAdminFirestore = () => getFirestore(app());
