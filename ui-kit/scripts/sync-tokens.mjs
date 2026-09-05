// Maintainer utility. Run from Web Reader: node --import tsx ui-kit/scripts/sync-tokens.mjs
// The exported kit itself needs no Node, React, Tailwind, or Web Reader runtime.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUILT_IN_THEME_COLORS, BUILT_IN_THEME_ACCENTS, ACCENT_PALETTE } from '../../src/lib/constants.ts';
import { getThemeCssVariables, getTexturePreviewStyle } from '../../src/lib/themeUtils.ts';

const kit = new URL('../', import.meta.url);
const root = new URL('../../', import.meta.url);
const themes = Object.fromEntries(Object.keys(BUILT_IN_THEME_COLORS).map(theme => [theme, getThemeCssVariables({ theme, customThemes: [] })]));
const textures = ['none', 'paper', 'linen', 'canvas', 'grid', 'grain'];
const block = (selector, variables) => `${selector} {\n${Object.entries(variables).map(([key, value]) => `  ${key}: ${value};`).join('\n')}\n}\n`;
let css = '/* Generated from Web Reader. Edit source then run scripts/sync-tokens.mjs. */\n';
for (const [name, variables] of Object.entries(themes)) {
  const accent = ACCENT_PALETTE[BUILT_IN_THEME_ACCENTS[name]];
  css += block(`${name === 'midnight' ? '.wr-kit,\n' : ''}.wr-kit[data-theme="${name}"]`, {
    ...variables, ...Object.fromEntries(Object.entries(accent).map(([shade, value]) => [`--accent-${shade}`, value])),
    'color-scheme': ['light', 'sepia'].includes(name) ? 'light' : 'dark',
  });
  for (const texture of textures) {
    const preview = getTexturePreviewStyle(texture, BUILT_IN_THEME_COLORS[name].text);
    css += block(`${name === 'midnight' ? `.wr-kit:not([data-theme])[data-texture="${texture}"],\n` : ''}.wr-kit[data-theme="${name}"][data-texture="${texture}"]`, {
      '--viewer-theme-texture': preview.backgroundImage,
      '--viewer-theme-texture-size': preview.backgroundSize,
    });
  }
}
for (const [name, shades] of Object.entries(ACCENT_PALETTE)) {
  css += block(`.wr-kit[data-accent="${name}"]`, Object.fromEntries(Object.entries(shades).map(([shade, value]) => [`--accent-${shade}`, value])));
}
const globals = readFileSync(new URL('src/app/globals.css', root), 'utf8');
for (const material of ['standard', 'glass', 'modern']) {
  const start = globals.indexOf(`[data-menu-style-material='${material}']`);
  const end = globals.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Missing material: ${material}`);
  const body = globals.slice(globals.indexOf('{', start) + 1, end);
  css += `${material === 'standard' ? '.wr-kit,\n' : ''}.wr-kit[data-material="${material}"] {\n  --app-menu-close-surface: initial;${body}\n}\n`;
}
writeFileSync(new URL('tokens.css', kit), css);
writeFileSync(new URL('tokens.json', kit), JSON.stringify({
  sourceVersion: JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim(),
  themes, defaultAccents: BUILT_IN_THEME_ACCENTS, accents: ACCENT_PALETTE,
  textures: Object.fromEntries(Object.entries(BUILT_IN_THEME_COLORS).map(([theme, colors]) => [theme, Object.fromEntries(textures.map(texture => [texture, getTexturePreviewStyle(texture, colors.text)]))])),
  geometry: { controls: [3, 5, 7, 8, 10, 12], panel: 14, search: 20, mobileSheet: 22 },
  sources: ['src/lib/constants.ts', 'src/lib/themeUtils.ts', 'src/lib/shelfDockTheme.ts', 'src/app/globals.css'],
}, null, 2) + '\n');
console.log('Updated ui-kit/tokens.css and tokens.json');
