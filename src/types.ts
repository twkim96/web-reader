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
  navMode: 'scroll' | 'page';
  fontFamily: 'sans' | 'serif' | 'ridi'; // ridi 옵션 추가
  encoding: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le'; // utf-16le 추가
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';