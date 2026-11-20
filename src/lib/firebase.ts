// src/lib/firebase.ts
import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { Firestore, getFirestore, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
export { APP_ID } from './appIdentity';

const isDev = process.env.NODE_ENV === 'development';
const location = typeof window === 'undefined' ? undefined : window.location;
const isTailnetDevOrigin = isDev && location
  && location.hostname === process.env.NEXT_PUBLIC_WEB_READER_TAILSCALE_DEV_HOST;
const previewAuthHost = process.env.NEXT_PUBLIC_WEB_READER_PREVIEW_AUTH_HOST;
const isRegisteredPreviewOrigin = previewAuthHost && location?.host === previewAuthHost;
const useHostedAuth = process.env.NEXT_PUBLIC_WEB_READER_PREVIEW === '1' || isTailnetDevOrigin;
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const defaultAuthDomain = useHostedAuth && projectId
  ? `${projectId}.firebaseapp.com`
  : process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: isRegisteredPreviewOrigin ? previewAuthHost : defaultAuthDomain,
  projectId,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

let db: Firestore;
try {
  db = initializeFirestore(app, {
    localCache: isDev 
      ? memoryLocalCache()  // 개발: 메모리 캐시 (오래된 pending writes 방지)
      : persistentLocalCache({ tabManager: persistentMultipleTabManager() })  // 운영: 오프라인 지원
  });
} catch {
  db = getFirestore(app);
}

const googleProvider = new GoogleAuthProvider();

export { auth, db, googleProvider };
