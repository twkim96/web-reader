const hexToRgb = (hex: string) => {
  const normalized = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.slice(1) : '000000';
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
};

export const getMuzioShelfDockVariables = (backgroundColor: string) => {
  const { r, g, b } = hexToRgb(backgroundColor);
  const darkSurface = ((r * 299) + (g * 587) + (b * 114)) / 1000 < 160;

  return {
    '--viewer-shelf-dock-surface': darkSurface
      ? 'rgba(31, 31, 31, 0.88)'
      : 'rgba(255, 255, 255, 0.88)',
    '--viewer-shelf-dock-border': darkSurface
      ? 'rgba(255, 255, 255, 0.045)'
      : 'rgba(228, 228, 231, 0.35)',
    '--viewer-shelf-dock-shadow': darkSurface
      ? 'rgba(0, 0, 0, 0.35)'
      : 'rgba(0, 0, 0, 0.10)',
  };
};
