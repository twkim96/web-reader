import type { AnnotationPaletteItem, HighlightColorId } from '../types';
import type { OwnerKey } from './ownerIdentity';
import { HIGHLIGHT_COLORS } from './annotationPolicy';

export const ANNOTATION_PALETTE_LABEL_MAX_LENGTH = 24;
export const ANNOTATION_PALETTE_MEANING_MAX_LENGTH = 80;

const DEFAULT_MEANINGS: Record<HighlightColorId, string> = {
  yellow: '중요',
  green: '기억',
  blue: '정보',
  pink: '감상',
  purple: '다시 보기',
};

export const DEFAULT_ANNOTATION_PALETTE: ReadonlyArray<AnnotationPaletteItem> =
  HIGHLIGHT_COLORS.map(({ id, label }) => ({
    id,
    label,
    meaning: DEFAULT_MEANINGS[id],
  }));

const paletteStorageKey = (ownerKey: OwnerKey) => (
  `reader_annotation_palette_v1:${encodeURIComponent(ownerKey)}`
);

const normalizeText = (value: unknown, maxLength: number) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

export const normalizeAnnotationPalette = (value: unknown): AnnotationPaletteItem[] => {
  const items = Array.isArray(value) ? value : [];
  return DEFAULT_ANNOTATION_PALETTE.map((fallback) => {
    const candidate = items.find((item) => (
      item && typeof item === 'object' && (item as { id?: unknown }).id === fallback.id
    )) as Partial<AnnotationPaletteItem> | undefined;
    return {
      id: fallback.id,
      label: normalizeText(candidate?.label, ANNOTATION_PALETTE_LABEL_MAX_LENGTH) || fallback.label,
      meaning: candidate && typeof candidate.meaning === 'string'
        ? normalizeText(candidate.meaning, ANNOTATION_PALETTE_MEANING_MAX_LENGTH)
        : fallback.meaning,
    };
  });
};

export const getStoredAnnotationPalette = (
  ownerKey: OwnerKey,
  storage?: Pick<Storage, 'getItem'>,
) => {
  const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  if (!target) return normalizeAnnotationPalette(undefined);
  try {
    const raw = target.getItem(paletteStorageKey(ownerKey));
    return normalizeAnnotationPalette(raw ? JSON.parse(raw) : undefined);
  } catch {
    return normalizeAnnotationPalette(undefined);
  }
};

export const saveStoredAnnotationPalette = (
  ownerKey: OwnerKey,
  palette: ReadonlyArray<AnnotationPaletteItem>,
  storage?: Pick<Storage, 'setItem'>,
) => {
  const target = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
  const normalized = normalizeAnnotationPalette(palette);
  try {
    target?.setItem(paletteStorageKey(ownerKey), JSON.stringify(normalized));
  } catch {
    // A palette is tiny, but private browsing or storage policy can still deny writes.
  }
  return normalized;
};

export const getAnnotationPaletteItem = (
  palette: ReadonlyArray<AnnotationPaletteItem>,
  colorId: HighlightColorId,
) => palette.find(({ id }) => id === colorId)
  ?? DEFAULT_ANNOTATION_PALETTE.find(({ id }) => id === colorId)
  ?? DEFAULT_ANNOTATION_PALETTE[0];
