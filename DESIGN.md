# DESIGN.md

## Atmosphere

Quiet reader utility. The interface should disappear behind the book: dark-native by default, compact controls, stable fixed overlays, and no decorative surfaces added for gesture-only features.

## Color

- `--viewer-theme-bg`: active reader and shelf background, sourced from `themeUtils`.
- `--viewer-theme-text`: active text color, sourced from `themeUtils`.
- `--viewer-theme-border`: modal and control borders, sourced from `themeUtils`.
- `--viewer-reader-surface`: reader toolbar/status surface, sourced from `themeUtils`.
- `--accent-400`, `--accent-500`, `--accent-600`: single app accent, sourced from `ACCENT_PALETTE`.
- Transparent interaction overlays use `transparent` only and must not introduce visible color.

## Typography

- App UI keeps the existing Tailwind font stack and reader-selected font family.
- Compact control labels use the existing uppercase small-label pattern.
- Gesture-only changes must not add visible explanatory copy.

## Spacing

- Use the existing Tailwind spacing scale.
- Fixed reader overlays must stay `inset-0` and must not shift layout.
- Gesture handlers must not add padding, margins, or visible hit targets.

## Components

- Reader interaction overlay: transparent, full viewport, above fixed-layout content, below reader chrome.
- Reader chrome: existing toolbar/status/modal components remain the visible controls.
- Zoom interaction: no buttons, no persistent indicator, no saved preference in 1.6.5.

## Motion

- Gesture zoom may update scale immediately.
- Any transition must use transform/opacity/filter only.
- Respect reduced-motion by avoiding decorative animation for zoom.

## Depth

- Keep existing tonal surfaces and modal shadows.
- Do not add new shadows or glass effects for invisible interaction layers.
