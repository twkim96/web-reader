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
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';