// src/lib/firebase.ts
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
// [Modified] getFirestore 대신 initializeFirestore, persistentLocalCache를 가져옵니다.
import { initializeFirestore, persistentLocalCache } from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// [Modified] 기존 getFirestore() + enableIndexedDbPersistence() 조합을 아래 한 줄로 대체
// 이렇게 하면 DB가 생성될 때 오프라인 캐시(Persistence)가 즉시 활성화됩니다.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache() 
});

const googleProvider = new GoogleAuthProvider();

export const APP_ID = "private-web-novel-viewer"; 

export { auth, db, googleProvider };