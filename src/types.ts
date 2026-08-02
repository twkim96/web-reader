// src/types.ts

import type { ArchiveFormat, ReaderFormat, SourceBookFormat } from './lib/bookFormats';

export interface Book {
  id: string;
  name: string;
  mimeType: string;
  size?: string | number;
  source?: 'cloud' | 'local';
  sourceFormat?: SourceBookFormat;
  readerFormat?: ReaderFormat;
  archiveFormat?: ArchiveFormat;
  modifiedTime?: string;
  md5Checksum?: string;
}

export type ThemeType = 'light' | 'dark' | 'sepia' | 'blue';

export interface ThemeClasses {
  bg: string;
  text: string;
  border: string;
  secondary: string;
}

export type CustomThemeTexture = 'none' | 'paper' | 'linen' | 'canvas' | 'grid' | 'grain';

export interface CustomTheme {
  id: string;
  title: string;
  bgColor: string;
  textColor: string;
  texture: CustomThemeTexture;
}

export interface ViewerSettings {
  fontSize: number;
  lineHeight: number;
  paragraphSpacing: number;
  padding: number;
  textAlign: 'left' | 'justify';
  theme: string;
  navMode: 'scroll' | 'page' | 'left-right' | 'all-dir';
  tapTopBottomPercent: number;
  tapLeftRightPercent: number;
  autoOpenLastBook: boolean;
  fontFamily: 'sans' | 'serif' | 'ridi';
  accentColor: string;
  customThemes?: CustomTheme[];
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

export type HighlightColorId = 'yellow' | 'green' | 'blue' | 'pink' | 'purple';

export interface AnnotationPaletteItem {
  id: HighlightColorId;
  label: string;
  meaning: string;
}

export type AnnotationAnchorState = 'active' | 'unresolved';

export interface Annotation {
  id: string;
  bookId: string;
  type: 'highlight';
  sectionIndex: number;
  rangeCfi: string;
  quote: string;
  prefix: string;
  suffix: string;
  colorId: HighlightColorId;
  note: string;
  progressPercent: number | null;
  chapter: string;
  createdAtClient: number;
  updatedAtClient: number;
  anchorState: AnnotationAnchorState;
}

export interface UserProgress {
  bookId: string;
  cfi: string;              // epub CFI (Canonical Fragment Identifier)
  anchorCfi?: string;       // viewport start CFI for precise cross-device resume
  progressPercent: number;
  lastRead: number;
  bookmarks?: Bookmark[]; 
  syncRevision?: number;   // authoritative Firebase head revision when known
  acceptedEventId?: string;
}

export interface SaveProgressOptions {
  force?: boolean;
  anchorCfi?: string;
  suppressLastReaderSession?: boolean;
}

export type ViewState = 'loading' | 'auth' | 'shelf' | 'reader';
