// src/types.ts

export interface Book {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Display size
}

export type ThemeType = 'light' | 'dark' | 'sepia' | 'blue';

export interface ViewerSettings {
  fontSize: number;
  lineHeight: number;
  padding: number;
  textAlign: 'left' | 'justify';
  theme: string;
  navMode: 'scroll' | 'page' | 'left-right' | 'all-dir';
  fontFamily: 'sans' | 'serif' | 'ridi';
  encoding: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le';
}

// [Added] 책갈피 타입 정의
export interface Bookmark {
  id: string;        // UUID or specific ID
  type: 'manual' | 'auto';
  name: string;      // Preview text
  charIndex: number; // Position
  createdAt: number;
  color: string;     // Color code (Tailwind class or Hex)
}

export interface UserProgress {
  bookId: string;
  charIndex: number;
  progressPercent: number;
  lastRead: any; // Firestore Timestamp
  // [Added] 책갈피 리스트 추가
  bookmarks?: Bookmark[]; 
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';