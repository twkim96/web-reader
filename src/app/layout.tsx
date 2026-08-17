// src/app/layout.tsx
import type { Metadata, Viewport } from "next";
import "./globals.css";

const themeBootstrapScript = `
(() => {
  const builtInThemes = {
    light: { bg: '#ffffff', text: '#222222', texture: 'none' },
    dark: { bg: '#272728', text: '#b8b8b8', texture: 'none' },
    blue: { bg: '#eef2f7', text: '#2c3e50', texture: 'none' },
    sepia: { bg: '#f4ecd8', text: '#5b4636', texture: 'none' }
  };
  const accents = {
    indigo: { 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5' },
    rose: { 400: '#fb7185', 500: '#f43f5e', 600: '#e11d48' },
    emerald: { 400: '#34d399', 500: '#10b981', 600: '#059669' },
    amber: { 400: '#fbbf24', 500: '#f59e0b', 600: '#d97706' },
    sky: { 400: '#38bdf8', 500: '#0ea5e9', 600: '#0284c7' },
    yellow: { 400: '#fbdf7e', 500: '#d4af37', 600: '#9a7b0c' }
  };
  const normalizeHex = (value, fallback) => {
    const raw = String(value || '').trim();
    const hex = raw.startsWith('#') ? raw : '#' + raw;
    return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
  };
  const hexToRgb = (hex) => {
    const value = Number.parseInt(normalizeHex(hex, '#000000').slice(1), 16);
    return { r: value >> 16 & 255, g: value >> 8 & 255, b: value & 255 };
  };
  const rgbString = (hex) => {
    const rgb = hexToRgb(hex);
    return rgb.r + ', ' + rgb.g + ', ' + rgb.b;
  };
  const mixHex = (a, b, amount) => {
    const first = hexToRgb(a);
    const second = hexToRgb(b);
    const mix = (x, y) => Math.round(x + (y - x) * amount);
    const toHex = (value) => value.toString(16).padStart(2, '0');
    return '#' + toHex(mix(first.r, second.r)) + toHex(mix(first.g, second.g)) + toHex(mix(first.b, second.b));
  };
  const textureVars = (texture, textColor) => {
    const textRgb = rgbString(textColor);
    if (texture === 'paper') return {
      '--viewer-theme-texture': 'radial-gradient(circle at 1px 1px, rgba(' + textRgb + ', 0.10) 1px, transparent 0)',
      '--viewer-theme-texture-size': '16px 16px'
    };
    if (texture === 'linen') return {
      '--viewer-theme-texture': 'linear-gradient(90deg, rgba(' + textRgb + ', 0.06) 1px, transparent 1px), linear-gradient(rgba(' + textRgb + ', 0.045) 1px, transparent 1px)',
      '--viewer-theme-texture-size': '22px 22px'
    };
    if (texture === 'canvas') return {
      '--viewer-theme-texture': 'repeating-linear-gradient(0deg, rgba(' + textRgb + ', 0.035) 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, rgba(' + textRgb + ', 0.045) 0 1px, transparent 1px 5px), linear-gradient(45deg, rgba(' + textRgb + ', 0.025) 25%, transparent 25%, transparent 75%, rgba(' + textRgb + ', 0.025) 75%)',
      '--viewer-theme-texture-size': '18px 18px'
    };
    if (texture === 'grid') return {
      '--viewer-theme-texture': 'linear-gradient(rgba(' + textRgb + ', 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(' + textRgb + ', 0.08) 1px, transparent 1px)',
      '--viewer-theme-texture-size': '28px 28px'
    };
    if (texture === 'grain') return {
      '--viewer-theme-texture': 'radial-gradient(circle at 20% 30%, rgba(' + textRgb + ', 0.08) 0 1px, transparent 1px), radial-gradient(circle at 80% 70%, rgba(' + textRgb + ', 0.05) 0 1px, transparent 1px), radial-gradient(circle at 45% 80%, rgba(' + textRgb + ', 0.045) 0 1px, transparent 1px)',
      '--viewer-theme-texture-size': '14px 14px'
    };
    return { '--viewer-theme-texture': 'none', '--viewer-theme-texture-size': 'auto' };
  };

  let settings = { theme: 'dark', accentColor: 'yellow', customThemes: [] };
  try {
    const stored = localStorage.getItem('viewer_settings');
    if (stored) settings = Object.assign(settings, JSON.parse(stored));
  } catch {}

  const customTheme = Array.isArray(settings.customThemes)
    ? settings.customThemes.find((theme) => theme && theme.id === settings.theme)
    : null;
  const theme = customTheme
    ? {
      bg: normalizeHex(customTheme.bgColor, '#272728'),
      text: normalizeHex(customTheme.textColor, '#b8b8b8'),
      texture: customTheme.texture || 'none'
    }
    : (builtInThemes[settings.theme] || builtInThemes.dark);
  const bg = normalizeHex(theme.bg, '#272728');
  const text = normalizeHex(theme.text, '#b8b8b8');
  const bgRgb = rgbString(bg);
  const textRgb = rgbString(text);
  const accent = accents[settings.accentColor] || accents.yellow;
  const vars = Object.assign({
    '--viewer-bootstrap-theme-bg': bg,
    '--viewer-bootstrap-theme-text': text,
    '--accent-400': accent[400],
    '--accent-500': accent[500],
    '--accent-600': accent[600],
    '--viewer-theme-bg': bg,
    '--viewer-theme-text': text,
    '--viewer-theme-border': 'rgba(' + textRgb + ', 0.18)',
    '--viewer-theme-secondary': mixHex(bg, text, 0.09),
    '--viewer-reader-surface': 'rgba(' + bgRgb + ', 0.68)'
  }, textureVars(theme.texture, text));
  const applyTheme = (target) => {
    Object.keys(vars).forEach((key) => target.style.setProperty(key, vars[key]));
    target.style.backgroundColor = bg;
    target.style.color = text;
  };
  const root = document.documentElement;
  root.dataset.viewerThemeBootstrapped = 'true';
  applyTheme(root);

  const style = document.createElement('style');
  style.id = 'viewer-theme-bootstrap-style';
  style.textContent = 'html[data-viewer-theme-bootstrapped] [style*="--viewer-theme-bg"]{--viewer-theme-bg:var(--viewer-bootstrap-theme-bg)!important;--viewer-theme-text:var(--viewer-bootstrap-theme-text)!important;background-color:var(--viewer-bootstrap-theme-bg)!important;color:var(--viewer-bootstrap-theme-text)!important}html[data-viewer-theme-bootstrapped] body{background:var(--viewer-bootstrap-theme-bg)!important;color:var(--viewer-bootstrap-theme-text)!important}';
  document.head.appendChild(style);

  const applyBody = () => {
    if (document.body) applyTheme(document.body);
  };
  if (document.body) applyBody();
  else document.addEventListener('DOMContentLoaded', applyBody, { once: true });
})();
`;

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  title: "Private Cloud Reader",
  description: "Your Personal Web Novel Vault",
  manifest: "/manifest.json", // 이 경로와 실제 파일명이 일치해야 합니다.
  icons: {
    icon: "/favicon.ico",
    apple: "/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "PC Reader",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <script
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
