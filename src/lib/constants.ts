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
  midnight: {
    bg: 'bg-[#141517]',
    text: 'text-[#d2d3d6]',
    border: 'border-white/10',
    secondary: 'bg-white/5'
  },
};

/**
 * 첫 페인트와 React 런타임이 함께 사용하는 내장 테마 원색입니다.
 * 서버 레이아웃의 초기 테마 주입에서도 이 값을 직렬화해 사용합니다.
 */
export const BUILT_IN_THEME_COLORS = {
  light: { bg: '#ffffff', text: '#222222', texture: 'none' },
  dark: { bg: '#272728', text: '#b8b8b8', texture: 'none' },
  sepia: { bg: '#f4ecd8', text: '#5b4636', texture: 'none' },
  midnight: { bg: '#141517', text: '#d2d3d6', texture: 'none' },
} as const;

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

export const BUILT_IN_THEME_ACCENTS: Record<string, string> = {
  light: 'rose',
  sepia: 'amber',
  dark: 'yellow',
  midnight: 'rose',
};

/**
 * 포인트 컬러의 실제 HEX 값
 */
export const ACCENT_PALETTE: Record<string, { 400: string; 500: string; 600: string }> = {
  indigo: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
  rose: { 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48' },
  emerald: { 400: '#7ba18c', 500: '#5A896F', 600: '#4a705b' },
  amber: { 400: '#cd7b6b', 500: '#C05A46', 600: '#9d4a39' },
  sky: { 400: '#73899b', 500: '#506C82', 600: '#42596b' },
  yellow: { 400: '#fbdf7e', 500: '#d4af37', 600: '#9a7b0c' },
};
