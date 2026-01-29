import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

/**
 * 전역 변수 선언 (TypeScript 환경 대응)
 */
declare global {
  var __firebase_config: string | undefined;
}

/**
 * 환경 변수 또는 전역 주입 설정 로드
 * Canvas의 특수 환경 변수와 로컬 .env 설정을 모두 지원합니다.
 */
const getFirebaseConfig = () => {
  // 1. Canvas 전역 주입 설정 확인
  if (typeof __firebase_config !== 'undefined' && __firebase_config) {
    try {
      return JSON.parse(__firebase_config);
    } catch (e) {
      console.error("Firebase config 파싱 실패:", e);
    }
  }

  // 2. 로컬 .env.local 설정 확인
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID
  };
};

const config = getFirebaseConfig();

// 필수 설정값이 없을 경우 경고 메시지 출력
if (!config.apiKey) {
  console.warn("Firebase API Key가 설정되지 않았습니다. .env.local 파일을 확인하거나 Firebase 설정을 주입해주세요.");
}

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const APP_ID = "private-web-novel-viewer";