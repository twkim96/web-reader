'use client';

import React from 'react';

const GENERATED_BOOK_COVER_PALETTE = [
  '#F59E0B',
  '#F97316',
  '#FB7185',
  '#E11D48',
  '#D946EF',
  '#A855F7',
  '#8B5CF6',
  '#6366F1',
  '#3B82F6',
  '#0EA5E9',
  '#06B6D4',
  '#14B8A6',
  '#10B981',
  '#22C55E',
  '#84CC16',
  '#EAB308',
] as const;

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

export const getGeneratedBookCoverStyle = (identity: string) => {
  const paletteIndex = hashIdentity(identity) % GENERATED_BOOK_COVER_PALETTE.length;
  const backgroundColor = GENERATED_BOOK_COVER_PALETTE[paletteIndex];
  const luminance = getRelativeLuminance(backgroundColor);
  const lightContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.05;
  const color = lightContrast >= darkContrast ? '#FFFFFF' : '#111827';
  return { backgroundColor, color, paletteIndex };
};

type GeneratedBookCoverVariant = 'simple' | 'grid' | 'list' | 'info';

interface GeneratedBookCoverProps {
  identity: string;
  title: string;
  variant: GeneratedBookCoverVariant;
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
  className = '',
}) => {
  const { backgroundColor, color, paletteIndex } = getGeneratedBookCoverStyle(identity);

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
