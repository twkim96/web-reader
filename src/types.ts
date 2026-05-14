// src/types.ts

export interface Book {
  id: string;
  name: string;
  mimeType: string;
  size?: string; // Display size
  source?: 'cloud' | 'local';
}

export type ThemeType = 'light' | 'dark' | 'sepia' | 'blue';

export interface ThemeClasses {
  bg: string;
  text: string;
  border: string;
  secondary: string;
}

export interface ViewerSettings {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  padding: number;
  textAlign: 'left' | 'justify';
  theme: string;
  navMode: 'scroll' | 'page' | 'left-right' | 'all-dir';
  fontFamily: 'sans' | 'serif' | 'ridi';
  accentColor: string;
}

// [Added] 책갈피 타입 정의
export interface Bookmark {
  id: string;        // UUID or specific ID
  type: 'manual' | 'auto';
  name: string;      // Preview text
  cfi: string;       // epub CFI position
  progressPercent?: number;
  createdAt: number;
  color: string;     // Color code (Tailwind class or Hex)
}

export interface UserProgress {
  bookId: string;
  cfi: string;              // epub CFI (Canonical Fragment Identifier)
  anchorCfi?: string;       // viewport start CFI for precise cross-device resume
  progressPercent: number;
  lastRead: number;
  bookmarks?: Bookmark[]; 
}

export interface SaveProgressOptions {
  force?: boolean;
  anchorCfi?: string;
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';
