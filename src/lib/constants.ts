// src/lib/constants.ts

/**
 * Moon Reader 스타일의 테마 설정
 */
export const THEMES = {
  light: {
    bg: 'bg-[#ffffff]',
    text: 'text-[#222222]',
    border: 'border-slate-200',
    secondary: 'bg-slate-100'
  },
  dark: {
    // [수정] 배경색을 #272728로, 텍스트 색상을 #b8b8b8로 변경
    bg: 'bg-[#272728]',
    text: 'text-[#b8b8b8]',
    border: 'border-white/10',
    secondary: 'bg-white/5'
  },
  sepia: {
    bg: 'bg-[#f4ecd8]',
    text: 'text-[#5b4636]',
    border: 'border-[#e4dcc8]',
    secondary: 'bg-[#e4dcc8]'
  },
  blue: {
    bg: 'bg-[#eef2f7]',
    text: 'text-[#2c3e50]',
    border: 'border-[#dde4ed]',
    secondary: 'bg-[#dde4ed]'
  },
};

/**
 * 포인트 컬러 리스트
 */
export const ACCENT_COLORS = [
  'indigo',
  'rose',
  'emerald',
  'amber',
  'sky',
  'yellow'
];

/**
 * 포인트 컬러의 실제 HEX 값
 */
export const ACCENT_PALETTE: Record<string, { 400: string; 500: string; 600: string }> = {
  indigo: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
  rose: { 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48' },
  emerald: { 400: '#34d399', 500: '#10b981', 600: '#059669' },
  amber: { 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706' },
  sky: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' },
  yellow: { 400: '#fbdf7e', 500: '#d4af37', 600: '#9a7b0c' },
};

/**
 * Google API 설정
 */
export const GOOGLE_DRIVE_CONFIG = {
  CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.readonly",
};