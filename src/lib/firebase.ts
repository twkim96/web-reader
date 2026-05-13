// src/lib/firebase.ts
import { getApps, initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { Firestore, getFirestore, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);

const isDev = process.env.NODE_ENV === 'development';

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

const googleDriveProvider = new GoogleAuthProvider();
googleDriveProvider.addScope('https://www.googleapis.com/auth/drive.file');
googleDriveProvider.setCustomParameters({ prompt: 'consent select_account' });

export const APP_ID = "private-web-novel-viewer";

export { auth, db, googleProvider, googleDriveProvider };
