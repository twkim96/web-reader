import type { CSSProperties } from 'react';
import type { CustomThemeTexture, ThemeClasses, ViewerSettings } from '../types.ts';
import { ACCENT_PALETTE, BUILT_IN_THEME_ACCENTS } from './constants.ts';
import { getMuzioShelfDockVariables } from './shelfDockTheme.ts';

export const CUSTOM_THEME_PREFIX = 'custom:';
export type ThemeLookupSettings = Pick<ViewerSettings, 'theme' | 'customThemes'>;
export type GoogleSignInButtonVariant = 'light' | 'dark';

export const normalizeHexColor = (value: string, fallback: string) => {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) return withHash.toLowerCase();
  return fallback;
};

export const createCustomThemeId = () => `${CUSTOM_THEME_PREFIX}${Date.now().toString(36)}`;

export const findCustomTheme = (settings: ThemeLookupSettings, themeId = settings.theme) => (
  settings.customThemes?.find((theme) => theme.id === themeId)
);

export const getThemeAccentColor = (
  settings: Pick<ViewerSettings, 'theme' | 'customThemes' | 'accentColor'>,
) => {
  const customTheme = findCustomTheme(settings);
  if (customTheme) {
    if (customTheme.accentColor && ACCENT_PALETTE[customTheme.accentColor]) {
      return customTheme.accentColor;
    }
    return ACCENT_PALETTE[settings.accentColor] ? settings.accentColor : 'rose';
  }
  return BUILT_IN_THEME_ACCENTS[settings.theme] || 'rose';
};

const getRelativeLuminance = (backgroundColor: string) => {
  const match = /^#([0-9a-f]{6})$/i.exec(backgroundColor.trim());
  if (!match) return 0;

  const value = Number.parseInt(match[1], 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const weights = [0.2126, 0.7152, 0.0722];
  return channels
    .map((channel) => channel / 255)
    .map((channel) => channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * weights[index], 0);
};

const hexToRgb = (hex: string) => {
  const normalized = normalizeHexColor(hex, '#000000').slice(1);
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
};

export const getGoogleSignInButtonVariant = (backgroundColor: string): GoogleSignInButtonVariant => {
  return getRelativeLuminance(backgroundColor) > 0.5 ? 'light' : 'dark';
};

const getRgbString = (hex: string) => {
  const { r, g, b } = hexToRgb(hex);
  return `${r}, ${g}, ${b}`;
};

const mixHex = (a: string, b: string, amount: number) => {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * amount);
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(mix(first.r, second.r))}${toHex(mix(first.g, second.g))}${toHex(mix(first.b, second.b))}`;
};

export const getCustomThemeClasses = (): ThemeClasses => ({
  bg: 'bg-[color:var(--viewer-theme-bg)] viewer-theme-texture',
  text: 'text-[color:var(--viewer-theme-text)]',
  border: 'border-[color:var(--viewer-theme-border)]',
  secondary: 'bg-[color:var(--viewer-theme-secondary)]',
});

export const getThemeClasses: (settings: ViewerSettings) => ThemeClasses = () => getCustomThemeClasses();

export const getThemeColors = (settings: ThemeLookupSettings) => {
  const customTheme = findCustomTheme(settings);
  if (customTheme) {
    return {
      bg: normalizeHexColor(customTheme.bgColor, '#f4ecd8'),
      text: normalizeHexColor(customTheme.textColor, '#5b4636'),
      texture: customTheme.texture,
    };
  }

  switch (settings.theme) {
    case 'light':
      return { bg: '#ffffff', text: '#222222', texture: 'none' as CustomThemeTexture };
    case 'dark':
      return { bg: '#272728', text: '#b8b8b8', texture: 'none' as CustomThemeTexture };
    case 'midnight':
      return { bg: '#141517', text: '#d2d3d6', texture: 'none' as CustomThemeTexture };
    case 'sepia':
      return { bg: '#f4ecd8', text: '#5b4636', texture: 'none' as CustomThemeTexture };
    default:
      return { bg: '#272728', text: '#b8b8b8', texture: 'none' as CustomThemeTexture };
  }
};

const getTextureVars = (texture: CustomThemeTexture, textColor: string) => {
  const textRgb = getRgbString(textColor);
  if (texture === 'paper') {
    return {
      '--viewer-theme-texture': `radial-gradient(circle at 1px 1px, rgba(${textRgb}, 0.10) 1px, transparent 0)`,
      '--viewer-theme-texture-size': '16px 16px',
    };
  }
  if (texture === 'linen') {
    return {
      '--viewer-theme-texture': `linear-gradient(90deg, rgba(${textRgb}, 0.06) 1px, transparent 1px), linear-gradient(rgba(${textRgb}, 0.045) 1px, transparent 1px)`,
      '--viewer-theme-texture-size': '22px 22px',
    };
  }
  if (texture === 'canvas') {
    return {
      '--viewer-theme-texture': `repeating-linear-gradient(0deg, rgba(${textRgb}, 0.035) 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, rgba(${textRgb}, 0.045) 0 1px, transparent 1px 5px), linear-gradient(45deg, rgba(${textRgb}, 0.025) 25%, transparent 25%, transparent 75%, rgba(${textRgb}, 0.025) 75%)`,
      '--viewer-theme-texture-size': '18px 18px',
    };
  }
  if (texture === 'grid') {
    return {
      '--viewer-theme-texture': `linear-gradient(rgba(${textRgb}, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(${textRgb}, 0.08) 1px, transparent 1px)`,
      '--viewer-theme-texture-size': '28px 28px',
    };
  }
  if (texture === 'grain') {
    return {
      '--viewer-theme-texture': `radial-gradient(circle at 20% 30%, rgba(${textRgb}, 0.08) 0 1px, transparent 1px), radial-gradient(circle at 80% 70%, rgba(${textRgb}, 0.05) 0 1px, transparent 1px), radial-gradient(circle at 45% 80%, rgba(${textRgb}, 0.045) 0 1px, transparent 1px)`,
      '--viewer-theme-texture-size': '14px 14px',
    };
  }
  return {
    '--viewer-theme-texture': 'none',
    '--viewer-theme-texture-size': 'auto',
  };
};

export const getTexturePreviewStyle = (
  texture: CustomThemeTexture,
  textColor: string
): CSSProperties => {
  const vars = getTextureVars(texture, textColor);
  return {
    backgroundImage: vars['--viewer-theme-texture'],
    backgroundSize: vars['--viewer-theme-texture-size'],
  };
};

export const getThemeTextureCss = (settings: ThemeLookupSettings) => {
  const colors = getThemeColors(settings);
  const vars = getTextureVars(colors.texture, normalizeHexColor(colors.text, '#5b4636'));
  return {
    image: vars['--viewer-theme-texture'],
    size: vars['--viewer-theme-texture-size'],
  };
};

export const getThemeCssVariables = (settings: ThemeLookupSettings): CSSProperties => {
  const colors = getThemeColors(settings);
  const bgColor = normalizeHexColor(colors.bg, '#f4ecd8');
  const textColor = normalizeHexColor(colors.text, '#5b4636');
  const bgRgb = getRgbString(bgColor);
  const textRgb = getRgbString(textColor);
  const secondaryColor = mixHex(bgColor, textColor, 0.09);
  const actionSoftColor = mixHex(bgColor, '#ffffff', 0.14);
  const actionStrongColor = mixHex(bgColor, '#000000', 0.18);
  const lightBackground = getRelativeLuminance(bgColor) > 0.5;

  return {
    '--viewer-theme-bg': bgColor,
    '--viewer-theme-text': textColor,
    '--viewer-theme-border': `rgba(${textRgb}, 0.18)`,
    '--viewer-theme-secondary': secondaryColor,
    '--viewer-theme-action-soft': actionSoftColor,
    '--viewer-theme-action-strong': actionStrongColor,
    '--viewer-reader-surface': `rgba(${bgRgb}, 0.68)`,
    '--viewer-reader-glass-surface': `rgba(${bgRgb}, 0.38)`,
    '--viewer-reader-glass-border': `rgba(${textRgb}, 0.24)`,
    '--viewer-shelf-glass-surface': `rgba(${bgRgb}, 0.24)`,
    '--viewer-shelf-glass-ink': lightBackground
      ? 'rgba(20, 21, 23, 0.88)'
      : 'rgba(245, 246, 248, 0.90)',
    '--viewer-shelf-glass-ink-edge': lightBackground
      ? 'rgba(255, 255, 255, 0.18)'
      : 'rgba(0, 0, 0, 0.18)',
    '--viewer-shelf-glass-ink-edge-opposite': 'transparent',
    '--viewer-shelf-glass-shadow': lightBackground
      ? 'rgba(20, 21, 23, 0.14)'
      : 'rgba(0, 0, 0, 0.24)',
    ...getMuzioShelfDockVariables(bgColor),
    ...getTextureVars(colors.texture, textColor),
  } as CSSProperties;
};
