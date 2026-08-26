'use client';

import React from 'react';

export const GENERATED_BOOK_COVER_PALETTE = [
  '#B3CACC',
  '#99C7E8',
  '#CCC9B4',
  '#E8E899',
  '#CCB4C2',
  '#E89A99',
  '#467377',
  '#778793',
  '#4D4720',
  '#696843',
] as const;

const MIN_SURROUNDING_CONTRAST_RATIO = 1.5;
const LIGHT_COVER_TEXT = '#FFFFFF';
const DARK_COVER_TEXT = '#111827';

const hashIdentity = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const hexChannelToLinear = (value: number) => {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
};

const getRelativeLuminance = (hex: string) => {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return (
    0.2126 * hexChannelToLinear(red)
    + 0.7152 * hexChannelToLinear(green)
    + 0.0722 * hexChannelToLinear(blue)
  );
};

const getContrastRatio = (left: string, right: string) => {
  const leftLuminance = getRelativeLuminance(left);
  const rightLuminance = getRelativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05)
    / (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
};

const normalizeBackgroundColor = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed || !/^#[0-9a-f]{6}$/i.test(trimmed)) return null;
  return trimmed.toUpperCase();
};

const selectPaletteIndex = (identity: string, surroundingBackgroundColor?: string) => {
  const startIndex = hashIdentity(identity) % GENERATED_BOOK_COVER_PALETTE.length;
  const surrounding = normalizeBackgroundColor(surroundingBackgroundColor);
  if (!surrounding) return startIndex;

  let bestIndex = startIndex;
  let bestContrast = 0;
  for (let offset = 0; offset < GENERATED_BOOK_COVER_PALETTE.length; offset += 1) {
    const paletteIndex = (startIndex + offset) % GENERATED_BOOK_COVER_PALETTE.length;
    const contrast = getContrastRatio(GENERATED_BOOK_COVER_PALETTE[paletteIndex], surrounding);
    if (contrast > bestContrast) {
      bestIndex = paletteIndex;
      bestContrast = contrast;
    }
    if (contrast >= MIN_SURROUNDING_CONTRAST_RATIO) return paletteIndex;
  }
  return bestIndex;
};

export const getGeneratedBookCoverStyle = (
  identity: string,
  surroundingBackgroundColor?: string,
) => {
  const paletteIndex = selectPaletteIndex(identity, surroundingBackgroundColor);
  const backgroundColor = GENERATED_BOOK_COVER_PALETTE[paletteIndex];
  const lightContrast = getContrastRatio(backgroundColor, LIGHT_COVER_TEXT);
  const darkContrast = getContrastRatio(backgroundColor, DARK_COVER_TEXT);
  const color = lightContrast >= darkContrast ? LIGHT_COVER_TEXT : DARK_COVER_TEXT;
  return { backgroundColor, color, paletteIndex };
};

type GeneratedBookCoverVariant = 'simple' | 'grid' | 'list' | 'info';

interface GeneratedBookCoverProps {
  identity: string;
  title: string;
  variant: GeneratedBookCoverVariant;
  surroundingBackgroundColor?: string;
  className?: string;
}

const variantClasses: Record<GeneratedBookCoverVariant, string> = {
  simple: 'text-[14px] leading-[1.15] sm:text-[15px]',
  grid: 'text-[9px] leading-[1.15] sm:text-[10px]',
  list: 'text-[7px] leading-[1.08]',
  info: 'text-[7px] leading-[1.12] sm:text-[8px]',
};

export const GeneratedBookCover: React.FC<GeneratedBookCoverProps> = ({
  identity,
  title,
  variant,
  surroundingBackgroundColor,
  className = '',
}) => {
  const { backgroundColor, color, paletteIndex } = getGeneratedBookCoverStyle(
    identity,
    surroundingBackgroundColor,
  );

  return (
    <div
      aria-hidden="true"
      data-generated-book-cover="true"
      data-generated-book-cover-palette={paletteIndex}
      data-generated-book-cover-variant={variant}
      className={`relative h-full w-full overflow-hidden text-center font-bold ${variantClasses[variant]} ${className}`}
      style={{ backgroundColor, color }}
    >
      <span
        data-generated-book-cover-title="true"
        className="absolute left-[9%] right-[9%] top-[15%] line-clamp-6 break-words [overflow-wrap:anywhere]"
      >
        {title}
      </span>
    </div>
  );
};
