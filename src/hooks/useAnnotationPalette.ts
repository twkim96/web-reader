'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AnnotationPaletteItem, HighlightColorId } from '../types';
import type { OwnerKey } from '../lib/ownerIdentity';
import {
  getStoredAnnotationPalette,
  normalizeAnnotationPalette,
  saveStoredAnnotationPalette,
} from '../lib/annotationPalette';

export const useAnnotationPalette = (ownerKey: OwnerKey) => {
  const [palette, setPalette] = useState<AnnotationPaletteItem[]>(() => (
    getStoredAnnotationPalette(ownerKey)
  ));

  useEffect(() => {
    setPalette(getStoredAnnotationPalette(ownerKey));
  }, [ownerKey]);

  const updatePaletteItem = useCallback((
    colorId: HighlightColorId,
    patch: Partial<Pick<AnnotationPaletteItem, 'label' | 'meaning'>>,
  ) => {
    setPalette((current) => {
      const next = normalizeAnnotationPalette(current.map((item) => (
        item.id === colorId ? { ...item, ...patch } : item
      )));
      saveStoredAnnotationPalette(ownerKey, next);
      return next;
    });
  }, [ownerKey]);

  const resetPalette = useCallback(() => {
    const next = normalizeAnnotationPalette(undefined);
    saveStoredAnnotationPalette(ownerKey, next);
    setPalette(next);
  }, [ownerKey]);

  return { palette, updatePaletteItem, resetPalette };
};
