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
 * Google API 설정
 */
export const GOOGLE_DRIVE_CONFIG = {
  CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
  SCOPES: "https://www.googleapis.com/auth/drive.readonly",
};