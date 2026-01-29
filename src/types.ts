// src/types.ts
import { User as FirebaseUser } from 'firebase/auth';

export interface Book {
  id: string;
  name: string;
  mimeType: string;
  content?: string;
  totalSize?: number;
}

export interface UserProgress {
  bookId: string;
  progressPercent: number;
  charIndex: number;
  lastRead: any;
}

export interface ViewerSettings {
  fontSize: number;
  lineHeight: number;
  padding: number;
  textAlign: 'left' | 'center' | 'justify';
  theme: 'light' | 'dark' | 'sepia' | 'blue';
  navMode: 'scroll' | 'page' | 'left-right' | 'all-dir'; // 모드 추가됨
  fontFamily: 'sans' | 'serif' | 'ridi';
  encoding: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le';
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';